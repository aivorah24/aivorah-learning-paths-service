const { chaptersFor } = require('../syllabus-map');
const { callWithFallback } = require('../llm/fallback');

// Maps each teacher subtopic to a real NCERT book section (with page) from the pre-built math_tutor_sections /
// unit_content_sections tables. A text search shortlists candidates; one small AI call per topic picks among them.
// Same grade first; neighbouring grades fill gaps (e.g. an old-syllabus Grade 6 "Decimals" lives in the Grade 7 book).

const isMaths = (subject) => /math/i.test(String(subject || ''));
const gradeNo = (grade) => parseInt(String(grade || '').replace(/\D/g, ''), 10);
const SHORTLIST_SIZE = 6;
const MATCH_CONCURRENCY = 3;
const MAX_SECTIONS_PER_SUBTOPIC = 2;

// Some built rows carry a too-late page_from (e.g. every later section = 55); the book examples' own pages are reliable.
function startPage(r) {
  const pages = [r.page_from, ...((r.tutor?.examples || []).map((e) => e.page))].map(Number).filter((p) => p > 0);
  return pages.length ? Math.min(...pages) : 1;
}

async function loadBookSections(grade, subject) {
  const g = gradeNo(grade);
  if (!g || !subject) return [];
  const grades = [g, g + 1, g - 1].filter((x) => x >= 1 && x <= 12);
  const maths = isMaths(subject);
  let query = require('../supabase').from(maths ? 'math_tutor_sections' : 'unit_content_sections')
    .select(maths ? 'grade, pdf_file, section_no, section_title, page_from, tutor' : 'grade, subject, pdf_file, section_no, section_title, page_from, learn, listen, quiz')
    .in('grade', grades);
  if (!maths) query = query.ilike('subject', subject);
  const { data, error } = await query.order('grade').order('pdf_file').order('section_no');
  if (error || !data) return [];

  const chapterByPdf = new Map();
  for (const gr of grades) {
    for (const ch of chaptersFor(gr, maths ? 'Mathematics' : subject)) chapterByPdf.set(String(ch.pdfFile).toLowerCase(), ch);
  }
  return data.map((r, i) => {
    const ch = chapterByPdf.get(String(r.pdf_file).toLowerCase());
    return {
      id: `S${i + 1}`,
      grade: r.grade,
      pdfFile: r.pdf_file,
      bookPath: ch?.bookPath || null,
      bookTitle: ch?.book || null,
      chapterTitle: ch?.title || null,
      title: r.section_title,
      page: startPage(r),
      tutor: r.tutor || null,
      learn: r.learn || null,
      listen: r.listen || null,
      quiz: r.quiz || null,
    };
  });
}

const STOPWORDS = new Set(['and', 'the', 'of', 'in', 'to', 'a', 'an', 'for', 'with', 'on', 'is', 'are', 'as', 'from', 'this', 'that', 'it', 'its', 'we', 'our', 'your', 'how', 'what', 'why', 'their', 'into', 'about', 'using', 'use', 'section', 'learn', 'understand', 'student', 'students']);
function words(text) {
  return new Set((String(text || '').toLowerCase().match(/[a-z]{3,}/g) || [])
    .filter((w) => !STOPWORDS.has(w))
    .map((w) => (w.length > 3 && w.endsWith('s') && !w.endsWith('ss') ? w.slice(0, -1) : w)));
}

function gist(s) {
  return String(s.tutor?.keyIdea || s.learn?.whatYoullLearn?.[0] || s.tutor?.intro || '').slice(0, 140);
}

// Word overlap weighted by field (section title > chapter title > key idea/intro/examples) and by rarity, so a
// specific word like "decimal" outweighs one that is everywhere like "number".
function sectionIndex(sections) {
  const entries = sections.map((s) => ({
    s,
    title: words(s.title),
    chapter: words(s.chapterTitle),
    body: words([s.tutor?.keyIdea, s.tutor?.intro, ...(s.tutor?.examples || []).map((e) => e.title), ...(s.learn?.whatYoullLearn || [])].join(' ')),
  }));
  const df = new Map();
  for (const e of entries) for (const w of new Set([...e.title, ...e.chapter, ...e.body])) df.set(w, (df.get(w) || 0) + 1);
  const idf = (w) => Math.log((entries.length + 1) / ((df.get(w) || 0) + 1));
  return { entries, idf };
}

function shortlist(index, subtopic, topicTitle, grade) {
  const own = words(subtopic);
  const context = words(topicTitle);
  const scored = index.entries.map(({ s, title, chapter, body }) => {
    let score = 0;
    for (const w of own) score += index.idf(w) * ((title.has(w) ? 3 : 0) + (chapter.has(w) ? 2 : 0) + (body.has(w) ? 1 : 0));
    for (const w of context) score += index.idf(w) * (title.has(w) || chapter.has(w) ? 0.5 : 0);
    if (score > 0 && s.grade === grade) score *= 1.1;
    return { s, score };
  });
  const top = scored.filter((x) => x.score >= 1).sort((a, b) => b.score - a.score);
  const picked = top.slice(0, SHORTLIST_SIZE).map((x) => x.s);
  // Each key word gets its best section in, so "Fractions and decimals" also lists a decimals section.
  for (const w of own) {
    const best = top.find((x) => index.entries.find((e) => e.s === x.s).title.has(w));
    if (best && !picked.includes(best.s)) picked.push(best.s);
  }
  return picked;
}

function buildTopicMatchPrompt(ref, candidateLists, grade, subject) {
  const lines = ref.subtopics.map((sub, j) => {
    const cands = candidateLists[j].map((s) => `   ${s.id} | Grade ${s.grade} | ${s.chapterTitle || s.pdfFile} | ${s.title} | ${gist(s)}`).join('\n');
    return `${j + 1}. "${sub}"\n${cands || '   (no candidates)'}`;
  }).join('\n');
  return `A Grade ${grade} ${subject} teacher's syllabus topic is "${ref.topicTitle}"${ref.unitTitle ? ` (unit: ${ref.unitTitle})` : ''}.
For each subtopic, pick the textbook section(s) from its candidates that teach it: usually one, two when the subtopic names two ideas that the book teaches in separate sections (e.g. "Rays and angles"). Use an empty list if none of them teaches it.

${lines}

Rules:
- Match by meaning. A section that teaches part of the subtopic counts; a section that only uses numbers or shapes while teaching something else does not.
- Do not pick a section about a different idea that happens to share a word (e.g. "decimal place value" for whole-number place value).
- Prefer Grade ${grade} sections; pick another grade only when no Grade ${grade} candidate teaches it.

Respond with ONLY JSON: {"picks": [["S12"], ["S3","S4"], [], ...one list per subtopic in order]}`;
}

// Subtopic list for matching; a topic without subtopics is matched by its own title.
function matchUnits(ref) {
  return ref.subtopics.length ? ref.subtopics : [ref.topicTitle];
}

async function matchOneTopic(ref, index, grade, subject) {
  const units = matchUnits(ref);
  const candidateLists = units.map((u) => shortlist(index, u, ref.topicTitle, grade));
  const empty = { subtopics: units.map((title) => ({ title, section: null, sections: [] })) };
  if (!candidateLists.some((c) => c.length)) return empty;

  const prompt = buildTopicMatchPrompt({ ...ref, subtopics: units }, candidateLists, grade, subject);
  let picks;
  try {
    picks = JSON.parse(await callWithFallback(prompt, { json: true, temperature: 0 }))?.picks;
  } catch (err) {
    console.error(`[bookMatch] match failed for "${ref.topicTitle}":`, err.message);
    return empty;
  }
  if (!Array.isArray(picks)) return empty;
  // A pick must come from that subtopic's own shortlist — never an id the model invented.
  return {
    subtopics: units.map((title, j) => {
      const ids = [].concat(picks[j] ?? []);
      const sections = candidateLists[j].filter((s) => ids.includes(s.id)).sort((a, b) => ids.indexOf(a.id) - ids.indexOf(b.id)).slice(0, MAX_SECTIONS_PER_SUBTOPIC);
      return { title, section: sections[0] || null, sections };
    }),
  };
}

// Returns Map<topicIndex, {subtopics:[{title, section}]}>; empty map when the book has no sections for this grade/subject.
async function matchTopicsToBook(topicRefs, metadata) {
  const sections = await loadBookSections(metadata?.grade, metadata?.subject).catch(() => []);
  const out = new Map();
  if (!sections.length || !topicRefs.length) return out;
  const index = sectionIndex(sections);
  const grade = gradeNo(metadata?.grade);
  let next = 0;
  async function worker() {
    while (next < topicRefs.length) {
      const i = next++;
      out.set(i, await matchOneTopic(topicRefs[i], index, grade, metadata?.subject));
    }
  }
  await Promise.all(Array.from({ length: Math.min(MATCH_CONCURRENCY, topicRefs.length) }, worker));
  return out;
}

// Distinct matched sections for a topic, in subtopic order.
function sectionsForTopic(match) {
  if (!match) return [];
  const seen = new Set();
  return match.subtopics.flatMap((s) => s.sections || [s.section]).filter((s) => s && !seen.has(s.id) && seen.add(s.id));
}

// Book pane data: opens at the first matched section; `pages` lets the teacher/student jump per subtopic.
function bookForTopic(match, sections) {
  if (!sections.length) return null;
  const first = sections[0];
  const pageOf = (s) => ({ pdfFile: s.pdfFile, bookPath: s.bookPath, bookTitle: s.bookTitle, chapterTitle: s.chapterTitle, grade: s.grade, pdfPage: s.page, section: s.title });
  return {
    pdfFile: first.pdfFile, bookPath: first.bookPath, bookTitle: first.bookTitle,
    chapterTitle: first.chapterTitle || first.title, pdfPage: first.page, grade: first.grade, confidence: 10,
    pages: match.subtopics.map((s) => ({
      subtopic: s.title,
      ...(s.section ? pageOf(s.section) : { pdfFile: null }),
      // Every section this subtopic was taught from, so a teacher edit of the picks keeps them all.
      sections: (s.sections || (s.section ? [s.section] : [])).map((x) => ({ pdfFile: x.pdfFile, title: x.title, page: x.page, grade: x.grade })),
    })),
  };
}

module.exports = { loadBookSections, matchTopicsToBook, sectionsForTopic, bookForTopic, shortlist, sectionIndex, buildTopicMatchPrompt, matchUnits };
