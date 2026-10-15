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
 *   cross_class: [{ context, kind, page_from, page_to, text }],  // kind: subject_intro (a subject's shared intro) | unsplit_table
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
// "Classes I & II", "CLASSES – I to III", "Classes I-II": one section shared by a band of classes.
const CLASS_BAND = /^\s*CLASS(?:ES)?\s*[-–:]?\s*([IVX]{1,4}|\d{1,2})\s*(?:&|and|to|-|–|,)\s*(?:CLASS(?:ES)?\s*)?([IVX]{1,4}|\d{1,2})\s*$/i;
// Hindi "कक्षा - I" / "कक्षा 1 – 2"; the conjunct often extracts as "क�ा".
const HINDI_CLASS = /^\s*क\S{0,4}ा\s*[-–:]?\s*([IVX]{1,4}|\d{1,2})\s*$/;
const HINDI_BAND = /^\s*क\S{0,4}ा\s*([IVX]{1,4}|\d{1,2})\s*[-–]\s*([IVX]{1,4}|\d{1,2})\s*$/;
// Subject headings in a framework document; a new one ends the previous subject's class section.
const FRAMEWORK_SUBJECTS = new Set(['ENGLISH', 'ENGLISH LANGUAGE', 'ENGLISH LITERATURE', 'HINDI', 'SECOND LANGUAGE', 'THIRD LANGUAGE',
  'MATHEMATICS', 'ENVIRONMENTAL STUDIES', 'SCIENCE', 'SOCIAL STUDIES', 'COMPUTER STUDIES', 'ARTS EDUCATION', 'ART EDUCATION',
  'PHYSICAL EDUCATION', 'HEALTH AND PHYSICAL EDUCATION', 'GENERAL KNOWLEDGE', 'VALUE EDUCATION',
  'HISTORY', 'CIVICS', 'HISTORY & CIVICS', 'HISTORY AND CIVICS', 'GEOGRAPHY', 'PHYSICS', 'CHEMISTRY', 'BIOLOGY']);
const UNIT_LINE = /^\s*(\d{1,2})\.\s+([A-Z(“"'][^\t]{2,150})$/;
const TOPIC_LINE = /^\s*\(([ivx]{1,5}|[a-z])\)\s*(\S.{1,300})$/;
// Theme-based curricula: "THEME 3: My Family", "Unit II – Plants", "Topic 4: Keyboard".
const PRACTICAL_HEADING = /^\s*(PAPER\s*[-–]?\s*II|PRACTICAL\s+WORK|PROJECT\s+WORK|INTERNAL\s+ASSESSMENT|LIST\s+OF\s+(EXPERIMENTS|PRACTICALS))/i;
const THEME_LINE = /^\s*(?:THEME|UNIT|TOPIC)\s*[-–:]?\s*(\d{1,2}|[IVX]{1,4})\s*[-–:.]?\s+(\S.{1,120})$/i;

function gradeFromHeading(line) {
  const m = line.match(CLASS_HEADING) || line.match(HINDI_CLASS);
  if (m) {
    const label = classLabel(gradeNumber(`Class ${m[1].toUpperCase()}`));
    return GRADE_LABELS.includes(label) ? label : null;
  }
  return PRESCHOOL_HEADING.test(line) ? PRESCHOOL : null;
}

// "Classes I to III" → ['Class I', 'Class II', 'Class III']; null when the line is not a band.
function gradesFromBand(line) {
  const m = line.match(CLASS_BAND) || line.match(HINDI_BAND);
  if (!m) return null;
  const [a, b] = [m[1], m[2]].map((x) => gradeNumber(`Class ${x.toUpperCase()}`));
  if (!(a >= 1 && b > a && b <= 12)) return null;
  const out = [];
  for (let n = a; n <= b; n++) out.push(classLabel(n));
  return out.every((g) => GRADE_LABELS.includes(g)) ? out : null;
}

function normalise(source, extraction) {
  const warnings = [...(extraction.warnings || [])];
  const isFramework = source.kind === 'FRAMEWORK_PDF';
  const subject = source.subject || (isFramework ? FRAMEWORK_SUBJECT : null);
  const version = source.version || `${String(source.programme).toLowerCase()}-${source.exam_year || 'undated'}`;
  const defaultGrades = source.grades || [];

  // Pass 1: walk lines, splitting at every CLASS heading. Each split is its
  // own segment (a 300-page framework repeats "CLASS I" once per subject),
  // labelled with its subject: the heading above it, or the cell next to it
  // ("CLASS - I | ENGLISH"). A band heading ("Classes I & II") starts one
  // segment shared by every class in the band.
  //
  // In a framework, a new subject heading ("HINDI") ends the previous class
  // section; the subject's introduction is kept in doc.cross_class.
  //
  // Some parts are laid out by skill with the classes as table columns
  // ("Class I | Class II | …"). After such a header row, each tab-separated
  // row is split by column into per-class segments; whatever cannot be tied
  // to a column is kept in doc.cross_class, never given to a guessed class.
  const segments = []; // { grades, kind: start|class|band|subject, context, startLine, lines: [{ text, first, rest, page }] }
  const crossClass = []; // { context, kind: 'unsplit_table', lines }
  let lineNo = 0;
  let current = { grades: [], kind: 'start', context: null, startLine: 0, lines: [] };
  segments.push(current);
  let lastHeading = null;
  let prevHeading = null; // the previous line, when it was heading-like
  let subjectHeading = null; // framework only
  let pendingTheme = null; // a "Theme N:" line above class bands, repeated into each band under it
  let table = null; // { cols: [grade|null], context, byGrade: Map, block }

  const startSeg = (grades, kind, context) => {
    current = { grades, kind, context, startLine: lineNo, lines: [] };
    segments.push(current);
    prevHeading = null;
  };
  const gradeSeg = (grade, context) => {
    if (!table.byGrade.has(grade)) {
      const seg = { grades: [grade], kind: 'class', context, startLine: lineNo, lines: [] };
      table.byGrade.set(grade, seg);
      segments.push(seg);
    }
    return table.byGrade.get(grade);
  };

  for (const p of extraction.pages) {
    let pageLine = 0;
    let headingAtTop = false; // the heading so far on this page began on its first line
    for (const raw of String(p.text || '').split('\n')) {
      const cells = raw.split('\t').map((c) => c.replace(/\s+/g, ' ').trim());
      const filled = cells.filter(Boolean);
      const text = filled.join(' ');
      if (!text) continue;
      lineNo++;
      pageLine++;
      const line = { text, first: filled[0], rest: filled.slice(1).join(' '), cells: filled, page: p.page };
      // A by-class table that has had no matching row for two pages is over;
      // later text stays in its cross-class block rather than being split.
      if (table && p.page > table.lastRowPage + 1) table = null;

      // A header row naming two or more classes starts a by-class table.
      const cellGrades = cells.map((c) => (CLASS_IN_CELL.test(c) ? gradeFromHeading(c) : null));
      const tokenGrades = [...text.matchAll(CLASS_TOKEN)].map((m) => gradeFromHeading(`CLASS ${m[1]}`)).filter(Boolean);
      const onlyClasses = text.replace(CLASS_TOKEN, '').replace(/[\s|,;&/-]|and/gi, '') === '';
      if (cellGrades.filter(Boolean).length >= 2 || (tokenGrades.length >= 2 && onlyClasses)) {
        let cols = cellGrades.filter(Boolean).length >= 2 ? cellGrades : null;
        // "Class III" alone on the line before "Class IV | Class V" is the same header
        // wrapped over two lines, so its columns cannot be trusted.
        if (current.kind === 'class' && !current.lines.length && current.startLine === lineNo - 1) {
          segments.splice(segments.indexOf(current), 1);
          cols = null;
        }
        const context = (isFramework && subjectHeading) || lastHeading;
        const block = { context, kind: 'unsplit_table', lines: [] };
        crossClass.push(block);
        table = { cols, context, byGrade: new Map(), block, lastRowPage: p.page };
        current = block;
        prevHeading = null;
        continue;
      }

      // "CLASS - I | ENGLISH": a class heading with its subject in the next cell.
      let g = gradeFromHeading(text);
      let cellSubject = null;
      if (!g && filled.length === 2) {
        const i = filled.findIndex((c) => gradeFromHeading(c));
        if (i >= 0 && isHeadingLike(filled[1 - i])) { g = gradeFromHeading(filled[i]); cellSubject = filled[1 - i]; }
      }
      // A band in a framework's general introduction ("Classes VI - VIII" in a subject list) is not a section.
      const band = g || (isFramework && !subjectHeading) ? null : gradesFromBand(text);
      if (g || band) {
        table = null;
        // "ENGLISH" directly above "CLASS I" introduces the new section, not the end of the last one.
        const prev = current.lines[current.lines.length - 1];
        if (prev && prev.text === lastHeading) current.lines.pop();
        if (cellSubject && isFramework && FRAMEWORK_SUBJECTS.has(cellSubject.toUpperCase())) subjectHeading = cellSubject;
        const context = cellSubject || (isFramework && subjectHeading) || lastHeading;
        if (g) {
          pendingTheme = null;
          // The same class under the same heading again (a repeated page header) continues the section.
          if (current.kind === 'class' && current.grades[0] === g && current.context === context) { prevHeading = null; continue; }
          startSeg([g], 'class', context);
        } else {
          startSeg(band, 'band', context);
          if (pendingTheme && pendingTheme.context === context) current.lines.push(pendingTheme.line);
        }
        continue;
      }

      if (isHeadingLike(text)) {
        // "SOCIAL" / "STUDIES" wrapped over two lines is one heading.
        const joined = prevHeading && (!/\s/.test(prevHeading) || !/\s/.test(text)) && `${prevHeading} ${text}`.length <= 60;
        lastHeading = joined ? `${prevHeading} ${text}` : text;
        if (joined && current.lines.length && current.lines[current.lines.length - 1].text === prevHeading) current.lines.pop();
        headingAtTop = joined ? headingAtTop : pageLine === 1;
        // "CLASS - VI" then "HISTORY": the subject names the class section just opened.
        if (isFramework && !joined && current.kind === 'class' && current.startLine === lineNo - 1 && FRAMEWORK_SUBJECTS.has(lastHeading.toUpperCase())) {
          subjectHeading = lastHeading;
          current.context = lastHeading;
          prevHeading = lastHeading;
          continue;
        }
        // A subject starts at the top of its own page; the same name in a contents list does not.
        const subj = isFramework && headingAtTop && FRAMEWORK_SUBJECTS.has(lastHeading.toUpperCase()) ? lastHeading : null;
        if (subj && subj !== subjectHeading) {
          subjectHeading = subj;
          pendingTheme = null;
          table = null;
          startSeg([], 'subject', subj);
        }
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

      // Arts: "Theme 2: Colour" then "CLASSES – I to III" … "CLASSES – IV & V".
      // The theme belongs to every band under it, not to the band before it.
      if (isFramework && current.kind !== 'class' && THEME_LINE.test(line.first)) {
        if (current.kind === 'band') startSeg([], 'subject', current.context);
        pendingTheme = { line, context: current.context };
      }
      current.lines.push(line);
    }
  }
  const unassigned = crossClass.filter((b) => b.lines.length);
  if (unassigned.length) {
    const pages = new Set(unassigned.flatMap((b) => b.lines.map((l) => l.page)));
    warnings.push(`${pages.size} page(s) of multi-class content could not be split by class — kept in cross_class, not assigned to any grade`);
  }
  // A subject's own introduction (before its first CLASS heading) is shared by all its classes.
  const subjectIntros = segments.filter((s) => s.kind === 'subject' && s.lines.length);

  // Lines before the first CLASS heading (cover, introduction, shared aims)
  // are kept once as the document preamble — never copied into every grade.
  // A document with no CLASS heading at all belongs to its declared grades.
  const headed = segments.filter((s) => s.grades.length && s.lines.length);
  const first = segments[0].lines;
  const byGrade = new Map();
  // The same subject reached twice for one class (e.g. split by an overview table) is one section.
  const push = (grade, seg) => {
    if (!byGrade.has(grade)) byGrade.set(grade, []);
    const list = byGrade.get(grade);
    const i = seg.context ? list.findIndex((s) => s.context === seg.context && s.kind === seg.kind) : -1;
    if (i >= 0) list[i] = { ...list[i], lines: [...list[i].lines, ...seg.lines] };
    else list.push(seg);
  };
  let preamble = null;
  if (!segments.some((s) => s.grades.length)) {
    const targets = defaultGrades.length ? defaultGrades : [];
    if (!targets.length) warnings.push('no CLASS heading found and the source declares no grades — content not assigned to any grade');
    for (const g of targets) push(g, segments[0]);
  } else {
    for (const seg of headed) for (const g of seg.grades) push(g, seg);
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
  // Some fonts (e.g. Devanagari conjuncts) extract as U+FFFD.
  const garbled = new Set();
  for (const g of grades) {
    for (const n of g.nodes.filter((x) => x.level === 'FRAMEWORK_SECTION')) {
      const all = `${n.title}\n${n.body || ''}`;
      if ((all.match(/�/g) || []).length / all.length > 0.002) garbled.add(n.title.split(' — ')[0]);
    }
  }
  if (garbled.size) warnings.push(`text did not extract cleanly (font encoding) in: ${[...garbled].join(', ')} — check it, or re-run with OCR`);

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
    cross_class: [...subjectIntros, ...unassigned].sort((a, b) => a.lines[0].page - b.lines[0].page).map((b) => ({
      context: b.context, kind: b.kind === 'subject' ? 'subject_intro' : 'unsplit_table',
      page_from: b.lines[0].page, page_to: b.lines[b.lines.length - 1].page, text: b.lines.map((l) => l.text).join('\n'),
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

const bandName = (grades) => `Classes ${grades[0].replace('Class ', '')}–${grades[grades.length - 1].replace('Class ', '')}`;

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
    let lastUnitNo = null;
    let practical = false;
    const run = { units: 0, withTopics: new Set() }; // current numbered run: a body has topics, a contents list does not
    let newSection = false; // "SECTION B: HISTORY" — numbering restarts legitimately
    const frameworkNode = (page) => framework || (framework = open({
      level: 'FRAMEWORK_SECTION', parent_id: null, ordinal: k + 1, number_label: null, path: `${prefix}framework`,
      title: seg.context ? `${seg.context} — ${label}${seg.kind === 'band' ? ` (shared: ${bandName(seg.grades)})` : ''}` : `${label} — general text`,
      body: '', page_from: page, page_to: page,
    }));
    // In a multi-section document every section gets its node up front, so
    // its units can hang under it and keep the subject they belong to.
    if (prefix && seg.lines.length) frameworkNode(seg.lines[0].page);
    // Once a section uses "Theme/Topic N:" units, its "1." lines are list items, not units.
    // A band's text is shared aims; its numbered lists are not units either.
    const themed = seg.kind === 'band' || seg.lines.some((l) => THEME_LINE.test(l.first || l.text));
    for (const { text, first = text, rest = '', cells = [], page } of seg.lines) {
      // Paper II / practical / project lists are numbered too but are not syllabus units.
      if (unitCount && (cells.length ? cells : [first]).some((c) => PRACTICAL_HEADING.test(c))) { practical = true; unit = null; topic = null; }
      if (practical) { append(frameworkNode(page), text, page); continue; }
      // Headings are read from the first table cell only; the other cells are body text.
      let u = (themed ? null : first.match(UNIT_LINE)) || first.match(THEME_LINE);
      // Two columns merged into one line: the next unit can sit in a later cell.
      let headingCell = first;
      if (!u && !themed && lastUnitNo !== null) {
        const cell = cells.slice(1).find((c) => {
          const m = c.match(UNIT_LINE);
          return m && parseInt(m[1], 10) === lastUnitNo + 1;
        });
        if (cell) { u = cell.match(UNIT_LINE); headingCell = cell; }
      }
      // Numbered units run in order (a restart at 1 is a contents list followed
      // by the body; one missed heading is tolerated); other jumps are body text.
      const numbered = u && /^\d+$/.test(u[1]) && !THEME_LINE.test(headingCell);
      const n = numbered ? parseInt(u[1], 10) : null;
      if ((cells.length ? cells : [first]).some((c) => /^SECTION\s+[A-Z]\b/i.test(c))) newSection = true;
      // A restart at 1 follows a contents list or a new section — not a body that
      // had topics (that restart is a practical/project list).
      const restartOk = n === 1 && (run.withTopics.size * 2 < run.units || newSection);
      const inSequence = !numbered || lastUnitNo === null || restartOk || (n > lastUnitNo && n <= lastUnitNo + 2);
      if (u && inSequence && n === 1) { run.units = 0; run.withTopics = new Set(); newSection = false; }
      if (u && inSequence && looksLikeTitle(u[2])) {
        if (numbered) lastUnitNo = parseInt(u[1], 10);
        run.units++;
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
      // Roman-numbered items inside a unit are topics even when the heading runs long.
      if (t && (looksLikeTitle(t[2]) || (/^[ivx]+$/.test(t[1]) && /^[A-Z0-9“"'(]/.test(t[2]) && t[2].length <= 300))) {
        const ordinal = nodes.filter((n) => n.level === 'TOPIC' && n._unit === unit).length + 1;
        run.withTopics.add(unit);
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

  // A unit listed twice (contents list, then body) keeps only the copy with the
  // most topics; titles match regardless of word order or punctuation.
  const topicCount = new Map();
  for (const n of nodes) if (n._unit) topicCount.set(n._unit, (topicCount.get(n._unit) || 0) + 1);
  // Letters only, sorted: also matches "Physical World andMeasurement" (lost space).
  const key = (n) => `${n.path.split('/')[0]}|${n.title.toLowerCase().replace(/&/g, 'and').replace(/[^a-z0-9]/g, '').split('').sort().join('')}`;
  const best = new Map();
  for (const n of nodes.filter((x) => x.level === 'UNIT')) {
    const b = best.get(key(n));
    if (!b || (topicCount.get(n) || 0) >= (topicCount.get(b) || 0)) best.set(key(n), n);
  }
  const dropped = new Set(nodes.filter((n) => n.level === 'UNIT' && best.get(key(n)) !== n));
  // A shortened contents-list title ("Behaviour of Perfect Gases and Kinetic") with
  // no topics, when a unit with topics starts the same way.
  const lead = (n) => `${n.path.split('/')[0]}|${n.title.toLowerCase().replace(/[^a-z0-9]/g, '').slice(0, 16)}`;
  const leadsWithTopics = new Set(nodes.filter((n) => n.level === 'UNIT' && topicCount.get(n)).map(lead));
  for (const n of nodes) if (n.level === 'UNIT' && !topicCount.get(n) && leadsWithTopics.has(lead(n))) dropped.add(n);
  for (let i = nodes.length - 1; i >= 0; i--) if (dropped.has(nodes[i]) || dropped.has(nodes[i]._unit)) nodes.splice(i, 1);

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
