/**
 * Normalise stage: page text → canonical JSON (one document per source).
 *
 * Canonical shape (schema_version 1):
 * {
 *   schema_version, curriculum_id: 'cisce', board: 'CISCE', programme, version, exam_year,
 *   content_origin: 'official_cisce', approved: false, pipeline_version,
 *   source: { source_id, url, final_url, sha256, page_count, title, kind, link_status },
 *   subject,                       // source subject, or FRAMEWORK_SUBJECT for frameworks
 *   provenance_status,             // VERIFIED_OFFICIAL | OFFICIAL_PARTIAL
 *   grades: [{ grade_label, grade_number, student_grade,
 *              nodes: [{ id, level, parent_id, ordinal, number_label, path, title, body,
 *                        page_from, page_to, content_hash }] }],
 *   extraction: { page_count, text_pages, ocr_pages, empty_pages, warnings, page_methods },
 *   warnings: []
 * }
 *
 * Structure is read only from the document's own headings: "CLASS IX",
 * "1. Unit title", "(i) topic" / "(a) topic". Nothing is generated; text that
 * fits no heading stays as body text of the nearest node.
 */
const { CURRICULUM_ID, BOARD, PIPELINE_VERSION, PRESCHOOL, GRADE_LABELS, gradeNumberOf, studentGradeOf, PROVENANCE, FRAMEWORK_SUBJECT } = require('./constants');
const { classLabel, gradeNumber } = require('../boardSyllabus');
const { uuidFrom, sha256 } = require('./ids');

const CLASS_HEADING = /^\s*CLASS(?:ES)?\s*[-–:]?\s*([IVX]{1,4}|\d{1,2})\s*$/i;
const PRESCHOOL_HEADING = /^\s*(PRE[-\s]?PRIMARY|PRE[-\s]?SCHOOL|NURSERY|KINDERGARTEN|LKG|UKG)\b.{0,40}$/i;
const UNIT_LINE = /^\s*(\d{1,2})\.\s+([A-Z(“"'][^\t]{2,150})$/;
const TOPIC_LINE = /^\s*\(([ivx]{1,5}|[a-z])\)\s+(\S.{1,300})$/;

function gradeFromHeading(line) {
  const m = line.match(CLASS_HEADING);
  if (m) {
    const label = classLabel(gradeNumber(`Class ${m[1].toUpperCase()}`));
    return GRADE_LABELS.includes(label) ? label : null;
  }
  return PRESCHOOL_HEADING.test(line) ? PRESCHOOL : null;
}

function normalise(source, extraction) {
  const warnings = [...(extraction.warnings || [])];
  const isFramework = source.kind === 'FRAMEWORK_PDF';
  const subject = source.subject || (isFramework ? FRAMEWORK_SUBJECT : null);
  const version = source.version || `${String(source.programme).toLowerCase()}-${source.exam_year || 'undated'}`;
  const defaultGrades = source.grades || [];

  // Pass 1: walk lines, splitting by grade heading.
  const segments = []; // { grade, lines: [{ text, page }] }
  let current = { grade: null, lines: [] };
  segments.push(current);
  for (const p of extraction.pages) {
    for (const raw of String(p.text || '').split('\n')) {
      const text = raw.replace(/\t+/g, ' ').replace(/\s+/g, ' ').trim();
      if (!text) continue;
      const g = gradeFromHeading(text);
      if (g) {
        current = { grade: g, lines: [] };
        segments.push(current);
        continue;
      }
      current.lines.push({ text, page: p.page });
    }
  }

  // Lines before any CLASS heading: they belong to the source's declared
  // grades only when it declares exactly one; otherwise (e.g. shared aims of
  // a IX–X syllabus) they are kept as framework text of each declared grade.
  const headed = segments.filter((s) => s.grade);
  const preamble = segments[0].lines;
  const byGrade = new Map();
  const push = (grade, lines) => { if (!byGrade.has(grade)) byGrade.set(grade, []); byGrade.get(grade).push(...lines); };
  if (headed.length === 0) {
    const targets = defaultGrades.length ? defaultGrades : [];
    if (!targets.length) warnings.push('no CLASS heading found and the source declares no grades — content not assigned to any grade');
    for (const g of targets) push(g, preamble);
  } else {
    for (const s of headed) push(s.grade, s.lines);
    if (preamble.length) for (const g of new Set(headed.map((s) => s.grade))) byGrade.get(g).unshift({ text: '__PREAMBLE__', page: preamble[0].page }, ...preamble, { text: '__END_PREAMBLE__' });
  }

  const grades = [];
  for (const label of GRADE_LABELS.filter((g) => byGrade.has(g))) {
    grades.push({
      grade_label: label,
      grade_number: gradeNumberOf(label),
      student_grade: studentGradeOf(label),
      nodes: buildNodes(byGrade.get(label), { version, sourceId: source.id, label, subject }),
    });
  }

  const hasStructure = grades.length > 0 && grades.every((g) => g.nodes.some((n) => n.level === 'TOPIC'));
  const fullyRead = extraction.emptyPages === 0;
  const provenance = !isFramework && source.link_status === 'VERIFIED' && hasStructure && fullyRead
    ? PROVENANCE.VERIFIED_OFFICIAL
    : PROVENANCE.OFFICIAL_PARTIAL;
  if (!hasStructure) warnings.push('no unit/topic structure found for at least one grade — framework text only');
  if (!fullyRead) warnings.push(`${extraction.emptyPages} page(s) have no text`);

  return {
    schema_version: 1,
    curriculum_id: CURRICULUM_ID,
    board: BOARD,
    programme: source.programme,
    version,
    exam_year: source.exam_year || null,
    content_origin: 'official_cisce',
    approved: false,
    pipeline_version: PIPELINE_VERSION,
    source: {
      source_id: source.id, url: source.url, final_url: source.final_url, sha256: extraction.sha256,
      page_count: extraction.pageCount, title: source.title, kind: source.kind, link_status: source.link_status,
    },
    subject,
    provenance_status: provenance,
    grades,
    extraction: {
      page_count: extraction.pageCount, text_pages: extraction.textPages, ocr_pages: extraction.ocrPages,
      empty_pages: extraction.emptyPages, warnings: extraction.warnings || [],
      page_methods: extraction.pages.map((p) => p.method),
    },
    warnings,
  };
}

// Pass 2 for one grade: lines → UNIT / TOPIC / FRAMEWORK_SECTION nodes.
function buildNodes(lines, { version, sourceId, label, subject }) {
  const nodes = [];
  let unit = null;
  let topic = null;
  let framework = null;
  let inPreamble = false;
  const idFor = (p) => uuidFrom('cisce', version, sourceId, label, subject, p);
  const open = (n) => { nodes.push(n); return n; };
  const append = (node, text, page) => {
    node.body = node.body ? `${node.body}\n${text}` : text;
    node.page_to = Math.max(node.page_to || page, page);
  };
  const frameworkNode = (page) => framework || (framework = open({
    level: 'FRAMEWORK_SECTION', parent_id: null, ordinal: 0, number_label: null, path: 'framework',
    title: 'General / framework text', body: '', page_from: page, page_to: page,
  }));

  for (const { text, page } of lines) {
    if (text === '__PREAMBLE__') { inPreamble = true; continue; }
    if (text === '__END_PREAMBLE__') { inPreamble = false; continue; }
    if (inPreamble) { append(frameworkNode(page), text, page); continue; }
    const u = text.match(UNIT_LINE);
    if (u) {
      const no = parseInt(u[1], 10);
      unit = open({
        level: 'UNIT', parent_id: null, ordinal: no, number_label: `${no}.`, path: `${no}`,
        title: u[2].trim(), body: '', page_from: page, page_to: page,
      });
      topic = null;
      continue;
    }
    const t = unit && text.match(TOPIC_LINE);
    if (t) {
      const ordinal = nodes.filter((n) => n.level === 'TOPIC' && n.path.startsWith(`${unit.path}.`)).length + 1;
      topic = open({
        level: 'TOPIC', parent_id: null, ordinal, number_label: `(${t[1]})`, path: `${unit.path}.${ordinal}`,
        title: t[2].trim(), body: '', page_from: page, page_to: page, _unit: unit,
      });
      continue;
    }
    if (topic) append(topic, text, page);
    else if (unit) append(unit, text, page);
    else append(frameworkNode(page), text, page);
  }

  // A unit number seen twice (e.g. a contents list then the body) keeps the
  // later occurrence's path unique.
  const seen = new Map();
  for (const n of nodes.filter((x) => x.level === 'UNIT')) {
    const k = n.path;
    const c = (seen.get(k) || 0) + 1;
    seen.set(k, c);
    if (c > 1) {
      const old = n.path;
      n.path = `${old}~${c}`;
      for (const t of nodes.filter((x) => x._unit === n)) t.path = t.path.replace(`${old}.`, `${n.path}.`);
    }
  }
  for (const n of nodes) {
    n.id = idFor(n.path);
    n.body = (n.body || '').trim() || null;
    n.content_hash = sha256(`${n.title}\n${n.body || ''}`);
  }
  for (const n of nodes) {
    if (n._unit) { n.parent_id = n._unit.id; delete n._unit; }
  }
  return nodes;
}

module.exports = { normalise, gradeFromHeading, UNIT_LINE, TOPIC_LINE };
