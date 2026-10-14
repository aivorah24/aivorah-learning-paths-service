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
 *   cross_class: [{ context, page_from, page_to, text }],  // multi-class text that could not be split by class
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
// The whole line must be the label ("PRE-PRIMARY", "Preschool Classes") — a
// sentence that merely mentions pre-primary is not a section heading.
const PRESCHOOL_HEADING = /^\s*(PRE[-\s]?PRIMARY|PRE[-\s]?SCHOOL|NURSERY|KINDERGARTEN|LKG|UKG)(\s+(CLASS(ES)?|LEVEL|STAGE|EDUCATION))?\s*$/i;
const CLASS_IN_CELL = /^\s*CLASS(?:ES)?\s*[-–:]?\s*([IVX]{1,4}|\d{1,2})\s*$/i;
const CLASS_TOKEN = /\bCLASS\s*[-–:]?\s*([IVX]{1,4}|\d{1,2})\b/gi;
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
  //
  // Some parts are laid out by skill with the classes as table columns
  // ("Class I | Class II | …"). After such a header row, each tab-separated
  // row is split by column into per-class segments; whatever cannot be tied
  // to a column is kept in doc.cross_class, never given to a guessed class.
  const segments = []; // { grade, context, lines: [{ text, first, rest, page }] }
  const crossClass = []; // { context, lines }
  let current = { grade: null, context: null, lines: [] };
  segments.push(current);
  let lastHeading = null;
  let prevHeading = null; // the previous line, when it was heading-like
  let table = null; // { cols: [grade|null], context, byGrade: Map, block }

  const gradeSeg = (grade, context) => {
    if (!table.byGrade.has(grade)) {
      const seg = { grade, context, lines: [] };
      table.byGrade.set(grade, seg);
      segments.push(seg);
    }
    return table.byGrade.get(grade);
  };

  for (const p of extraction.pages) {
    for (const raw of String(p.text || '').split('\n')) {
      const cells = raw.split('\t').map((c) => c.replace(/\s+/g, ' ').trim());
      const filled = cells.filter(Boolean);
      const text = filled.join(' ');
      if (!text) continue;
      const line = { text, first: filled[0], rest: filled.slice(1).join(' '), page: p.page };
      // A by-class table that has had no matching row for two pages is over;
      // later text stays in its cross-class block rather than being split.
      if (table && p.page > table.lastRowPage + 1) table = null;

      // A header row naming two or more classes starts a by-class table.
      const cellGrades = cells.map((c) => (CLASS_IN_CELL.test(c) ? gradeFromHeading(c) : null));
      const tokenGrades = [...text.matchAll(CLASS_TOKEN)].map((m) => gradeFromHeading(`CLASS ${m[1]}`)).filter(Boolean);
      const onlyClasses = text.replace(CLASS_TOKEN, '').replace(/[\s|,;&/-]|and/gi, '') === '';
      if (cellGrades.filter(Boolean).length >= 2 || (tokenGrades.length >= 2 && onlyClasses)) {
        const block = { context: lastHeading, lines: [] };
        crossClass.push(block);
        table = { cols: cellGrades.filter(Boolean).length >= 2 ? cellGrades : null, context: lastHeading, byGrade: new Map(), block, lastRowPage: p.page };
        current = block;
        prevHeading = null;
        continue;
      }

      const g = gradeFromHeading(text);
      if (g) {
        table = null;
        // "ENGLISH" directly above "CLASS I" introduces the new section, not the end of the last one.
        const prev = current.lines[current.lines.length - 1];
        if (prev && prev.text === lastHeading) current.lines.pop();
        // The same class under the same heading again (a repeated page header) continues the section.
        if (current.grade === g && current.context === lastHeading) { prevHeading = null; continue; }
        current = { grade: g, context: lastHeading, lines: [] };
        segments.push(current);
        prevHeading = null;
        continue;
      }

      if (isHeadingLike(text)) {
        // "SOCIAL" / "STUDIES" wrapped over two lines is one heading.
        const joined = prevHeading && (!/\s/.test(prevHeading) || !/\s/.test(text)) && `${prevHeading} ${text}`.length <= 60;
        lastHeading = joined ? `${prevHeading} ${text}` : text;
        if (joined && current.lines.length && current.lines[current.lines.length - 1].text === prevHeading) current.lines.pop();
        prevHeading = lastHeading;
        current.lines.push({ ...line, text: lastHeading, first: lastHeading, rest: '' });
        continue;
      }
      prevHeading = null;

      if (table && table.cols && cells.length === table.cols.length && filled.length > 1) {
        table.lastRowPage = p.page;
        const label = cells.filter((c, j) => c && !table.cols[j]).join(' ');
        cells.forEach((c, j) => {
          if (!c || !table.cols[j]) return;
          const t = label ? `${label} — ${c}` : c;
          gradeSeg(table.cols[j], table.context).lines.push({ text: t, first: t, rest: '', page: p.page });
        });
        continue;
      }
      current.lines.push(line);
    }
  }
  const unassigned = crossClass.filter((b) => b.lines.length);
  if (unassigned.length) {
    const pages = new Set(unassigned.flatMap((b) => b.lines.map((l) => l.page)));
    warnings.push(`${pages.size} page(s) of multi-class content could not be split by class — kept in cross_class, not assigned to any grade`);
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
    cross_class: unassigned.map((b) => ({
      context: b.context, page_from: b.lines[0].page, page_to: b.lines[b.lines.length - 1].page, text: b.lines.map((l) => l.text).join('\n'),
    })),
    grades,
    extraction: {
      page_count: extraction.pageCount, text_pages: extraction.textPages, ocr_pages: extraction.ocrPages,
      empty_pages: extraction.emptyPages, warnings: extraction.warnings || [],
      page_methods: extraction.pages.map((p) => p.method),
    },
    warnings,
  };
}

// A heading is short and starts with a capital — "(b) printing done by 'B' can
// also be beautiful…" is a sentence in a list, not a topic.
function looksLikeTitle(t) {
  const s = String(t || '').trim();
  return /^[A-Z0-9“"'(]/.test(s) && s.length <= 120 && s.split(/\s+/).length <= 12;
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
    for (const { text, first = text, rest = '', page } of seg.lines) {
      // Headings are read from the first table cell only; the other cells are body text.
      const u = first.match(UNIT_LINE) || first.match(THEME_LINE);
      if (u && looksLikeTitle(u[2])) {
        unitCount++;
        const no = /^\d+$/.test(u[1]) ? parseInt(u[1], 10) : unitCount;
        unit = open({
          level: 'UNIT', parent_id: null, ordinal: no, number_label: /^\d+$/.test(u[1]) && !THEME_LINE.test(first) ? `${no}.` : u[1],
          path: `${prefix}${no}`, title: u[2].trim(), body: rest, page_from: page, page_to: page, _section: framework,
        });
        topic = null;
        continue;
      }
      const t = unit && first.match(TOPIC_LINE);
      if (t && looksLikeTitle(t[2])) {
        const ordinal = nodes.filter((n) => n.level === 'TOPIC' && n._unit === unit).length + 1;
        topic = open({
          level: 'TOPIC', parent_id: null, ordinal, number_label: `(${t[1]})`, path: `${unit.path}.${ordinal}`,
          title: t[2].trim(), body: rest, page_from: page, page_to: page, _unit: unit,
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

module.exports = { normalise, gradeFromHeading, isHeadingLike, looksLikeTitle, UNIT_LINE, TOPIC_LINE, THEME_LINE };
