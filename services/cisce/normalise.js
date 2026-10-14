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
 *   preamble,                      // { page_from, page_to, text } before the first CLASS heading, or null
 *   grades: [{ grade_label, grade_number, student_grade, section_count,
 *              nodes: [{ id, level, parent_id, ordinal, number_label, path, title, body,
 *                        page_from, page_to, content_hash }] }],
 *   extraction: { page_count, text_pages, ocr_pages, empty_pages, warnings, page_methods },
 *   warnings: []
 * }
 *
 * Structure is read only from the document's own headings: "CLASS IX",
 * "1. Unit title" or "THEME 1: title", "(i) topic" / "(a) topic". Nothing is
 * generated; text that fits no heading stays as body text of the nearest node.
 * Theme-based frameworks (e.g. the CISCE Primary Curriculum, which "does not
 * proceed with a list of topics") come out as one FRAMEWORK_SECTION per
 * CLASS section, each with its own pages and the heading above it.
 */
const { CURRICULUM_ID, BOARD, PIPELINE_VERSION, PRESCHOOL, GRADE_LABELS, gradeNumberOf, studentGradeOf, PROVENANCE, FRAMEWORK_SUBJECT } = require('./constants');
const { classLabel, gradeNumber } = require('../boardSyllabus');
const { uuidFrom, sha256 } = require('./ids');

const CLASS_HEADING = /^\s*CLASS(?:ES)?\s*[-–:]?\s*([IVX]{1,4}|\d{1,2})\s*$/i;
const PRESCHOOL_HEADING = /^\s*(PRE[-\s]?PRIMARY|PRE[-\s]?SCHOOL|NURSERY|KINDERGARTEN|LKG|UKG)\b.{0,40}$/i;
const UNIT_LINE = /^\s*(\d{1,2})\.\s+([A-Z(“"'][^\t]{2,150})$/;
const TOPIC_LINE = /^\s*\(([ivx]{1,5}|[a-z])\)\s+(\S.{1,300})$/;
// Theme-based curricula: "THEME 3: My Family", "Unit II – Plants".
const THEME_LINE = /^\s*(?:THEME|UNIT)\s*[-–:]?\s*(\d{1,2}|[IVX]{1,4})\s*[-–:.]?\s+(\S.{1,120})$/i;

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

  // Pass 1: walk lines, splitting at every CLASS heading. Each split is its
  // own segment (a 300-page framework repeats "CLASS I" once per subject),
  // labelled with the last heading-like line seen before it (e.g. a subject).
  const segments = []; // { grade, context, lines: [{ text, page }] }
  let current = { grade: null, context: null, lines: [] };
  segments.push(current);
  let lastHeading = null;
  for (const p of extraction.pages) {
    for (const raw of String(p.text || '').split('\n')) {
      const text = raw.replace(/\t+/g, ' ').replace(/\s+/g, ' ').trim();
      if (!text) continue;
      const g = gradeFromHeading(text);
      if (g) {
        // "ENGLISH" directly above "CLASS I" introduces the new section, not the end of the last one.
        const prev = current.lines[current.lines.length - 1];
        if (prev && prev.text === lastHeading) current.lines.pop();
        current = { grade: g, context: lastHeading, lines: [] };
        segments.push(current);
        continue;
      }
      if (isHeadingLike(text)) lastHeading = text;
      current.lines.push({ text, page: p.page });
    }
  }

  // Lines before the first CLASS heading (cover, introduction, shared aims)
  // are kept once as the document preamble — never copied into every grade.
  // A document with no CLASS heading at all belongs to its declared grades.
  const headed = segments.filter((s) => s.grade);
  const first = segments[0].lines;
  const byGrade = new Map();
  const push = (grade, seg) => { if (!byGrade.has(grade)) byGrade.set(grade, []); byGrade.get(grade).push(seg); };
  let preamble = null;
  if (headed.length === 0) {
    const targets = defaultGrades.length ? defaultGrades : [];
    if (!targets.length) warnings.push('no CLASS heading found and the source declares no grades — content not assigned to any grade');
    for (const g of targets) push(g, segments[0]);
  } else {
    for (const seg of headed) push(seg.grade, seg);
    if (first.length) {
      preamble = { page_from: first[0].page, page_to: first[first.length - 1].page, text: first.map((l) => l.text).join('\n') };
    }
  }

  const grades = [];
  for (const label of GRADE_LABELS.filter((g) => byGrade.has(g))) {
    grades.push({
      grade_label: label,
      grade_number: gradeNumberOf(label),
      student_grade: studentGradeOf(label),
      nodes: buildNodes(byGrade.get(label), { version, sourceId: source.id, label, subject }),
      section_count: byGrade.get(label).length,
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
    preamble,
    grades,
    extraction: {
      page_count: extraction.pageCount, text_pages: extraction.textPages, ocr_pages: extraction.ocrPages,
      empty_pages: extraction.emptyPages, warnings: extraction.warnings || [],
      page_methods: extraction.pages.map((p) => p.method),
    },
    warnings,
  };
}

// "ENGLISH", "READING WRITING VOCABULARY" — short, upper-case, not a number line.
function isHeadingLike(text) {
  return text.length >= 3 && text.length <= 60 && /[A-Z]{3}/.test(text) && text === text.toUpperCase()
    && !/^\d/.test(text) && !/^\(/.test(text);
}

// Pass 2 for one grade: its segments → FRAMEWORK_SECTION / UNIT / TOPIC nodes.
// Each segment keeps its own page range; with several segments, paths are
// prefixed "s<k>/" so units numbered "1." in two subjects never collide.
function buildNodes(segs, { version, sourceId, label, subject }) {
  const nodes = [];
  const idFor = (p) => uuidFrom('cisce', version, sourceId, label, subject, p);
  const open = (n) => { nodes.push(n); return n; };
  const append = (node, text, page) => {
    node.body = node.body ? `${node.body}\n${text}` : text;
    node.page_from = Math.min(node.page_from, page);
    node.page_to = Math.max(node.page_to, page);
  };

  segs.forEach((seg, k) => {
    const prefix = segs.length > 1 ? `s${k + 1}/` : '';
    let unit = null;
    let topic = null;
    let framework = null;
    let unitCount = 0;
    const frameworkNode = (page) => framework || (framework = open({
      level: 'FRAMEWORK_SECTION', parent_id: null, ordinal: k + 1, number_label: null, path: `${prefix}framework`,
      title: seg.context ? `${seg.context} — ${label}` : `${label} — general text`, body: '', page_from: page, page_to: page,
    }));
    // In a multi-section document every section gets its node up front, so
    // its units can hang under it and keep the subject they belong to.
    if (prefix && seg.lines.length) frameworkNode(seg.lines[0].page);
    for (const { text, page } of seg.lines) {
      const u = text.match(UNIT_LINE) || text.match(THEME_LINE);
      if (u) {
        unitCount++;
        const no = /^\d+$/.test(u[1]) ? parseInt(u[1], 10) : unitCount;
        unit = open({
          level: 'UNIT', parent_id: null, ordinal: no, number_label: /^\d+$/.test(u[1]) && !THEME_LINE.test(text) ? `${no}.` : u[1],
          path: `${prefix}${no}`, title: u[2].trim(), body: '', page_from: page, page_to: page, _section: framework,
        });
        topic = null;
        continue;
      }
      const t = unit && text.match(TOPIC_LINE);
      if (t) {
        const ordinal = nodes.filter((n) => n.level === 'TOPIC' && n._unit === unit).length + 1;
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
  });

  // A unit number seen twice in one segment (e.g. a contents list then the
  // body) keeps the later occurrence's path unique.
  const seen = new Map();
  for (const n of nodes.filter((x) => x.level === 'UNIT')) {
    const c = (seen.get(n.path) || 0) + 1;
    seen.set(n.path, c);
    if (c > 1) n.path = `${n.path}~${c}`;
  }
  for (const n of nodes) {
    if (n._unit) n.path = `${n._unit.path}.${n.ordinal}`;
  }
  for (const n of nodes) {
    n.id = idFor(n.path);
    n.body = (n.body || '').trim() || null;
    n.content_hash = sha256(`${n.title}\n${n.body || ''}`);
  }
  for (const n of nodes) {
    if (n._unit) n.parent_id = n._unit.id;
    if (n._section) n.parent_id = n._section.id;
    delete n._unit;
    delete n._section;
  }
  return nodes;
}

module.exports = { normalise, gradeFromHeading, isHeadingLike, UNIT_LINE, TOPIC_LINE, THEME_LINE };
