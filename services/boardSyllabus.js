/**
 * services/boardSyllabus.js
 * Learning Path subjects/chapters/topics for boards that have NO official
 * textbook in Aivorah yet — ICSE and Cambridge.
 *
 * Their content was ingested by the monolith's
 * scripts/ingest-icse-cambridge-all.js (AI-generated, syllabus-outline only)
 * and seed-multi-curriculum-g1-g5-semantic.js, under grade labels that never
 * match a student profile's "Grade N":
 *
 *   ICSE       syllabus_chapters.grade = "Class VI"      Qdrant grade = "Class VI"
 *   Cambridge  syllabus_chapters.grade = "Stage 6" / "IGCSE Year 10"
 *              Qdrant ai_mentor_content grade = "Grade 6" (no chapter field)
 *              Qdrant aivorah_curriculum_chunks_v1 = "Grade 1".."Grade 5" topic maps
 *
 * so /curriculum/subjects came back empty and the Learning Path showed no
 * subjects at all. This module resolves every alias for the student's grade
 * and merges all three sources. Because there is no official textbook, every
 * topic is returned with comingSoon: true — students can browse the syllabus,
 * and opening a topic shows "Coming soon" instead of a lesson.
 */
const { scrollAll, IB_COLLECTION, NCERT_COLLECTION } = require('./qdrant');

const ROMAN = ['', 'I', 'II', 'III', 'IV', 'V', 'VI', 'VII', 'VIII', 'IX', 'X', 'XI', 'XII'];
const ROMAN_TO_NUM = Object.fromEntries(ROMAN.map((r, i) => [r, i]).filter(([r]) => r));

function boardKind(curriculum) {
  const c = String(curriculum || '').trim().toLowerCase();
  if (c === 'icse') return 'ICSE';
  if (c === 'cambridge') return 'Cambridge';
  return null;
}

// Boards whose Learning Path is syllabus-only (no textbook → no lessons yet).
function isBoardWithoutBooks(curriculum) {
  return boardKind(curriculum) !== null;
}

// "Grade 6" | "Class VI" | "Class 6" | "Stage 6" | "IGCSE Year 10" → 6
function gradeNumber(grade) {
  const s = String(grade || '').trim();
  const digits = s.match(/(\d{1,2})/);
  if (digits) return parseInt(digits[1], 10);
  const roman = s.toUpperCase().match(/\b([IVX]{1,4})\b\s*$/);
  return roman && ROMAN_TO_NUM[roman[1]] ? ROMAN_TO_NUM[roman[1]] : null;
}

// 9 → "Class IX". The one place a grade number becomes a CISCE class label.
function classLabel(n) {
  return ROMAN[n] ? `Class ${ROMAN[n]}` : null;
}

// Every grade label a board's content may have been stored under.
function boardGradeAliases(curriculum, grade) {
  const n = gradeNumber(grade);
  const out = new Set([String(grade || '').trim()].filter(Boolean));
  if (n) {
    out.add(`Grade ${n}`);
    out.add(`Class ${n}`);
    if (ROMAN[n]) out.add(classLabel(n));
    if (boardKind(curriculum) === 'Cambridge') {
      out.add(`Stage ${n}`);
      out.add(`Year ${n}`);
      out.add(`IGCSE Year ${n}`);
    }
  }
  return [...out];
}

function curriculumValues(curriculum) {
  const kind = boardKind(curriculum);
  return [...new Set([String(curriculum).trim(), kind, kind && kind.toUpperCase()].filter(Boolean))];
}

function looksLikeRealTopicName(topic) {
  const t = String(topic || '').trim();
  if (!t) return false;
  if (/^\[?IMAGE\]?/i.test(t) || /^this image/i.test(t)) return false;
  if (/^[a-z]+\d{2,4}$/i.test(t)) return false; // raw PDF code
  return true;
}

const comingSoonTopic = (id, name) => ({ id, name, kind: 'coming_soon', page: '', comingSoon: true });

// ── Sources ──────────────────────────────────────────────────────────────

// Syllabus outline (chapters + topics) written to Supabase by the ingestion
// pipeline. Only board-level rows (school_id null) — a school's own uploads
// reach students through teacher learning paths, not here.
async function dbChapters(curriculum, grade, subject) {
  // Required lazily so routes that never reach an ICSE/Cambridge request
  // (and their tests) don't need Supabase configured just to load.
  const supabase = require('./supabase');
  let q = supabase
    .from('syllabus_chapters')
    .select('id, unit_no, title, subject, grade')
    .in('curriculum', curriculumValues(curriculum))
    .in('grade', boardGradeAliases(curriculum, grade))
    .is('school_id', null);
  if (subject) q = q.ilike('subject', subject);
  const { data: chapters, error } = await q.order('unit_no');
  if (error || !chapters?.length) return [];
  const ids = chapters.map((c) => c.id);
  const { data: topics } = await supabase
    .from('syllabus_topics')
    .select('id, chapter_id, topic_order, name')
    .in('chapter_id', ids)
    .order('topic_order');
  const byChapter = {};
  for (const t of topics || []) (byChapter[t.chapter_id] ||= []).push(t);
  // One grade alias wins per subject (the scope a re-run would replace) so
  // the same chapter stored under two labels is never listed twice.
  const gradeBySubject = {};
  for (const c of chapters) gradeBySubject[c.subject] ||= c.grade;
  return chapters
    .filter((c) => c.grade === gradeBySubject[c.subject])
    .map((c) => ({
      subject: c.subject,
      unitNo: c.unit_no,
      title: c.title,
      topics: (byChapter[c.id] || []).filter((t) => looksLikeRealTopicName(t.name)).map((t) => ({ id: t.id, name: t.name })),
    }));
}

// Exam year a grade sits its board exam in, for the current academic year
// (April–March): in Oct 2026, Class X/XII → 2027, Class IX/XI → 2028.
function examYearFor(n, now = new Date()) {
  const yearEnd = now.getMonth() >= 3 ? now.getFullYear() + 1 : now.getFullYear();
  return n === 9 || n === 11 ? yearEnd + 1 : yearEnd;
}

// Official CISCE syllabus (cisce_curriculum_nodes, from the cisce-ingest
// pipeline) for ICSE IX–X / ISC XI–XII. Per subject, the version for the
// student's exam year wins, else the nearest year available.
// Supabase returns at most 1000 rows per request; read every page.
async function selectAll(build) {
  const rows = [];
  for (let from = 0; ; from += 1000) {
    const { data, error } = await build().order('id').range(from, from + 999);
    if (error) return { data: null, error };
    rows.push(...(data || []));
    if (!data || data.length < 1000) return { data: rows, error: null };
  }
}

async function officialChapters(curriculum, grade, subject) {
  const n = gradeNumber(grade);
  if (boardKind(curriculum) === 'Cambridge' && n >= 1 && n <= 12) return boardNodeChapters('CAMBRIDGE', n, subject);
  if (boardKind(curriculum) !== 'ICSE' || !n || n > 12) return [];
  if (n <= 8) return frameworkChapters(n, subject);
  const supabase = require('./supabase');
  const { data, error } = await selectAll(() => {
    const q = supabase
      .from('cisce_curriculum_nodes')
      .select('id, exam_year, subject, level, parent_id, ordinal, title')
      .eq('grade_label', classLabel(n))
      .in('programme', ['ICSE', 'ISC'])
      .in('level', ['UNIT', 'TOPIC']);
    return subject ? q.ilike('subject', subject) : q;
  });
  if (error || !data?.length) return [];

  const want = examYearFor(n);
  const yearBySubject = {};
  for (const r of data) {
    if (r.level !== 'UNIT') continue;
    const cur = yearBySubject[r.subject];
    if (cur === undefined || Math.abs(r.exam_year - want) < Math.abs(cur - want)) yearBySubject[r.subject] = r.exam_year;
  }
  const rows = data.filter((r) => r.exam_year === yearBySubject[r.subject]);
  const topicsByUnit = {};
  for (const t of rows.filter((r) => r.level === 'TOPIC')) (topicsByUnit[t.parent_id] ||= []).push(t);
  return rows
    .filter((r) => r.level === 'UNIT')
    .sort((a, b) => a.subject.localeCompare(b.subject) || a.ordinal - b.ordinal)
    .map((u) => ({
      subject: u.subject,
      unitNo: u.ordinal,
      title: u.title,
      topics: (topicsByUnit[u.id] || []).sort((a, b) => a.ordinal - b.ordinal).map((t) => ({ id: t.id, name: t.title })),
    }));
}

// Cambridge (and later IB) outlines from board_syllabus_nodes (scripts/cambridge-ingest.cjs).
// A syllabus covers a range of exam years; per subject the one covering the
// student's exam year wins, else the nearest.
async function boardNodeChapters(board, n, subject) {
  const supabase = require('./supabase');
  const { data, error } = await selectAll(() => {
    const q = supabase
      .from('board_syllabus_nodes')
      .select('id, subject, version, year_from, year_to, level, parent_id, ordinal, title')
      .eq('board', board)
      .lte('grade_from', n)
      .gte('grade_to', n);
    return subject ? q.ilike('subject', subject) : q;
  });
  if (error || !data?.length) return [];
  const want = examYearFor(n);
  const distance = (r) => (want < r.year_from ? r.year_from - want : want > r.year_to ? want - r.year_to : 0);
  const versionBySubject = {};
  for (const r of data.filter((x) => x.level === 'UNIT')) {
    const cur = versionBySubject[r.subject];
    if (!cur || distance(r) < cur.d) versionBySubject[r.subject] = { v: r.version, d: distance(r) };
  }
  const rows = data.filter((r) => versionBySubject[r.subject]?.v === r.version);
  const topicsByUnit = {};
  for (const t of rows.filter((r) => r.level === 'TOPIC')) (topicsByUnit[t.parent_id] ||= []).push(t);
  return rows
    .filter((r) => r.level === 'UNIT')
    .sort((a, b) => a.subject.localeCompare(b.subject) || a.ordinal - b.ordinal)
    .map((u) => ({
      subject: u.subject,
      unitNo: u.ordinal,
      title: u.title,
      topics: (topicsByUnit[u.id] || []).sort((a, b) => a.ordinal - b.ordinal).map((t) => ({ id: t.id, name: t.title })),
    }));
}

// CISCE's Classes I–VIII curricula are one framework document per stage; each
// subject is a section ("MATHEMATICS — Class VI") whose units are its chapters.
const SECTION_SUBJECT = { HISTORY: 'History & Civics', CIVICS: 'History & Civics', 'HISTORY & CIVICS': 'History & Civics', 'HISTORY AND CIVICS': 'History & Civics', 'ARTS EDUCATION': 'Art', 'ART EDUCATION': 'Art' };
const titleCase = (s) => s.toLowerCase().replace(/\b[a-z]/g, (c) => c.toUpperCase());
function sectionSubject(title) {
  const head = String(title || '').split(' — ')[0].trim().toUpperCase();
  return SECTION_SUBJECT[head] || titleCase(head);
}

async function frameworkChapters(n, subject) {
  const supabase = require('./supabase');
  const { data, error } = await selectAll(() => supabase
    .from('cisce_curriculum_nodes')
    .select('id, level, parent_id, ordinal, path, title')
    .eq('grade_label', classLabel(n))
    .in('programme', ['PRIMARY', 'UPPER_PRIMARY'])
    .in('level', ['FRAMEWORK_SECTION', 'UNIT', 'TOPIC']));
  if (error || !data?.length) return [];
  const sections = new Map(data.filter((r) => r.level === 'FRAMEWORK_SECTION').map((r) => [r.id, sectionSubject(r.title)]));
  const topicsByUnit = {};
  for (const t of data.filter((r) => r.level === 'TOPIC')) (topicsByUnit[t.parent_id] ||= []).push(t);
  const want = subject && String(subject).trim().toLowerCase();
  const perSubject = {};
  return data
    .filter((r) => r.level === 'UNIT' && sections.has(r.parent_id))
    .map((u) => ({ u, subj: sections.get(u.parent_id) }))
    .filter(({ subj }) => !want || subj.toLowerCase() === want)
    .sort((a, b) => a.subj.localeCompare(b.subj) || a.u.path.localeCompare(b.u.path, undefined, { numeric: true }))
    .map(({ u, subj }) => ({
      subject: subj,
      // History and Civics share one card; keep their chapters in document order.
      unitNo: (perSubject[subj] = (perSubject[subj] || 0) + 1),
      title: u.title,
      topics: (topicsByUnit[u.id] || []).sort((a, b) => a.ordinal - b.ordinal).map((t) => ({ id: t.id, name: t.title })),
    }));
}

// Topic-level content in Qdrant (no chapter structure).
async function qdrantTopics(curriculum, grade, subject) {
  const must = [
    { key: 'curriculum', match: { any: curriculumValues(curriculum) } },
    { key: 'grade', match: { any: boardGradeAliases(curriculum, grade) } },
  ];
  if (subject) must.push({ key: 'subject', match: { value: subject } });
  const collections = boardKind(curriculum) === 'Cambridge' ? [IB_COLLECTION, NCERT_COLLECTION] : [IB_COLLECTION];
  const results = await Promise.all(collections.map((c) => scrollAll(c, { must }).catch(() => [])));
  return results.flat()
    .map((p) => p.payload || {})
    .filter((p) => p.subject && looksLikeRealTopicName(p.topic))
    .map((p) => ({ subject: p.subject, topic: p.topic, unit: p.unit || '' }));
}

// "Mathematics Grade 3 Topic Map" is a seeding label, not a chapter name.
function unitTitle(unit) {
  const u = String(unit || '').trim();
  return !u || /topic map$/i.test(u) ? 'Topics' : u;
}

// ── Public API ───────────────────────────────────────────────────────────

/** Subjects grid for an ICSE/Cambridge student — same shape as listSubjects(). */
async function listBoardSubjects(curriculum, grade) {
  const [official, aiChapters, aiPoints] = await Promise.all([
    officialChapters(curriculum, grade).catch(() => []),
    dbChapters(curriculum, grade).catch(() => []),
    qdrantTopics(curriculum, grade).catch(() => []),
  ]);
  // A class with an official CISCE syllabus shows only official subjects; the AI
  // outline fills in only classes that have none.
  const notOfficial = () => official.length === 0;
  const chapters = [...official, ...aiChapters.filter(notOfficial)];
  const points = aiPoints.filter(notOfficial);
  const bySubject = new Map();
  const entry = (subject) => {
    const key = subject.trim().toLowerCase();
    if (!bySubject.has(key)) bySubject.set(key, { subject: subject.trim(), chapters: [], topics: new Map() });
    return bySubject.get(key);
  };
  for (const ch of chapters) {
    const e = entry(ch.subject);
    e.chapters.push({ unitNo: ch.unitNo, title: ch.title });
    for (const t of ch.topics) if (!e.topics.has(t.name)) e.topics.set(t.name, { topic: t.name, unit: ch.title, description: '' });
  }
  for (const p of points) {
    const e = entry(p.subject);
    if (!e.topics.has(p.topic)) e.topics.set(p.topic, { topic: p.topic, unit: unitTitle(p.unit), description: '' });
  }
  return [...bySubject.values()]
    .filter((e) => e.chapters.length || e.topics.size)
    .sort((a, b) => a.subject.localeCompare(b.subject))
    .map((e) => ({
      subject: e.subject,
      topicCount: e.topics.size,
      topics: [...e.topics.values()],
      units: e.chapters.map((c) => c.title),
      chapters: e.chapters,
      comingSoon: true,
    }));
}

/** Chapter → topic tree for one subject — same unit shape as listSyllabus(). */
async function listBoardSyllabus(curriculum, grade, subject) {
  const official = await officialChapters(curriculum, grade, subject).catch(() => []);
  const chapters = official.length ? official : await dbChapters(curriculum, grade, subject).catch(() => []);
  if (chapters.length) {
    // A chapter whose syllabus lists no topics (e.g. CISCE Classes I–VIII) is
    // shown as one topic of the same name; a pending chapter is hidden by the app.
    return chapters.map((ch, i) => ({
      unitNo: ch.unitNo,
      title: ch.title,
      topics: ch.topics.length
        ? ch.topics.map((t) => comingSoonTopic(t.id, t.name))
        : [comingSoonTopic(`board:${curriculum}:${grade}:${subject}:${i + 1}`, ch.title)],
      comingSoon: true,
      pending: false,
    }));
  }
  // No outline in the DB: group the Qdrant topics by their unit label.
  const points = await qdrantTopics(curriculum, grade, subject).catch(() => []);
  const byUnit = new Map();
  for (const p of points) {
    const title = unitTitle(p.unit);
    if (!byUnit.has(title)) byUnit.set(title, new Map());
    const topics = byUnit.get(title);
    if (!topics.has(p.topic)) topics.set(p.topic, comingSoonTopic(`board:${curriculum}:${grade}:${subject}:${p.topic}`, p.topic));
  }
  return [...byUnit.entries()].map(([title, topics], i) => ({
    unitNo: i + 1,
    title,
    topics: [...topics.values()],
    comingSoon: true,
    pending: false,
  }));
}

module.exports = { isBoardWithoutBooks, boardGradeAliases, gradeNumber, classLabel, examYearFor, listBoardSubjects, listBoardSyllabus };
