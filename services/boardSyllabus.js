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
  const [chapters, points] = await Promise.all([
    dbChapters(curriculum, grade).catch(() => []),
    qdrantTopics(curriculum, grade).catch(() => []),
  ]);
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
  const chapters = await dbChapters(curriculum, grade, subject).catch(() => []);
  if (chapters.length) {
    return chapters.map((ch) => ({
      unitNo: ch.unitNo,
      title: ch.title,
      topics: ch.topics.map((t) => comingSoonTopic(t.id, t.name)),
      comingSoon: true,
      pending: ch.topics.length === 0,
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

module.exports = { isBoardWithoutBooks, boardGradeAliases, gradeNumber, classLabel, listBoardSubjects, listBoardSyllabus };
