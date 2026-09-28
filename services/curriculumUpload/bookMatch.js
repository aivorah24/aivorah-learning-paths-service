const { chaptersFor } = require('../syllabus-map');
const { callWithFallback } = require('../llm/fallback');

// Maps each teacher topic/subtopic to real NCERT book sections (with page numbers) from the pre-built
// math_tutor_sections / unit_content_sections tables. Same grade first; neighbouring grades only fill gaps
// (e.g. an old-syllabus Grade 6 "Decimals" topic lives in the new Grade 7 book).

const isMaths = (subject) => /math/i.test(String(subject || ''));
const gradeNo = (grade) => parseInt(String(grade || '').replace(/\D/g, ''), 10);

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
    .select(maths ? 'grade, pdf_file, section_no, section_title, page_from, tutor' : 'grade, subject, pdf_file, section_no, section_title, page_from, learn')
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
    };
  });
}

function buildMatchPrompt(topicRefs, sections, grade) {
  const gist = (s) => String(s.tutor?.keyIdea || s.learn?.whatYoullLearn?.[0] || '').slice(0, 140);
  const sectionList = sections.map((s) => `${s.id} | Grade ${s.grade} | ${s.chapterTitle || s.pdfFile} | ${s.title} | ${gist(s)}`).join('\n');
  const topicList = topicRefs.map((t, i) => {
    const subs = t.subtopics.map((s, j) => `    ${j}. ${s}`).join('\n');
    return `T${i}: "${t.topicTitle}" (unit: ${t.unitTitle || '-'})${subs ? `\n${subs}` : ''}`;
  }).join('\n');
  return `A Grade ${grade} teacher uploaded a syllabus outline. Match each topic and each of its subtopics to the NCERT textbook section that actually teaches it.

BOOK SECTIONS (id | grade | chapter | section | what it teaches):
${sectionList}

TEACHER TOPICS (subtopics numbered):
${topicList}

Rules:
- Match by meaning, not shared words: pick the section that best teaches that idea (use "what it teaches").
- A section that only uses numbers or shapes while teaching something else does not count.
- Prefer Grade ${grade} sections. Use another grade's section only if no Grade ${grade} section teaches it.
- Use null only when no section teaches it at all.

Respond with ONLY JSON: {"topics":[{"t":"T0","topic":"S5"|null,"subtopics":["S7"|null, ...one per subtopic in order]}]}`;
}

function parseMatch(raw, topicRefs, sections) {
  const byId = new Map(sections.map((s) => [s.id, s]));
  const pick = (id) => (typeof id === 'string' && byId.has(id) ? byId.get(id) : null);
  let parsed;
  try { parsed = JSON.parse(raw); } catch { return null; }
  if (!Array.isArray(parsed?.topics)) return null;
  const out = new Map();
  for (const entry of parsed.topics) {
    const idx = Number(String(entry?.t || '').replace(/\D/g, ''));
    const ref = topicRefs[idx];
    if (!ref) continue;
    const subs = Array.isArray(entry.subtopics) ? entry.subtopics : [];
    out.set(idx, {
      topic: pick(entry.topic),
      subtopics: ref.subtopics.map((title, j) => ({ title, section: pick(subs[j]) })),
    });
  }
  return out;
}

const MATCH_VOTES = 3;

// Majority vote on the chapter, then the most-picked section inside it (single answers varied a lot by model).
function voteMatches(runs, topicRefs) {
  const need = Math.floor(runs.length / 2) + 1;
  const winner = (picks) => {
    const chosen = picks.filter(Boolean);
    const byPdf = new Map();
    for (const s of chosen) byPdf.set(s.pdfFile, (byPdf.get(s.pdfFile) || 0) + 1);
    const [pdf, n] = [...byPdf.entries()].sort((a, b) => b[1] - a[1])[0] || [];
    if (!pdf || n < need) return null;
    const counts = new Map();
    for (const s of chosen.filter((x) => x.pdfFile === pdf)) counts.set(s.id, { s, n: (counts.get(s.id)?.n || 0) + 1 });
    return [...counts.values()].sort((a, b) => b.n - a.n || a.s.page - b.s.page)[0].s;
  };
  const out = new Map();
  topicRefs.forEach((ref, i) => {
    const per = runs.map((r) => r.get(i)).filter(Boolean);
    if (!per.length) return;
    out.set(i, {
      topic: winner(per.map((m) => m.topic)),
      subtopics: ref.subtopics.map((title, j) => ({ title, section: winner(per.map((m) => m.subtopics[j]?.section)) })),
    });
  });
  return out;
}

// Returns Map<topicIndex, {topic, subtopics:[{title, section}]}>; empty map when nothing can be matched.
async function matchTopicsToBook(topicRefs, metadata) {
  const sections = await loadBookSections(metadata?.grade, metadata?.subject).catch(() => []);
  if (!sections.length || !topicRefs.length) return new Map();
  const prompt = buildMatchPrompt(topicRefs, sections, gradeNo(metadata?.grade));
  const runs = [];
  for (let attempt = 1; attempt <= MATCH_VOTES + 1 && runs.length < MATCH_VOTES; attempt += 1) {
    try {
      const matched = parseMatch(await callWithFallback(prompt, { json: true, temperature: 0 }), topicRefs, sections);
      if (matched) runs.push(matched);
    } catch (err) {
      console.error('[bookMatch] match call failed:', err.message);
    }
  }
  if (runs.length <= 1) return runs[0] || new Map();
  return voteMatches(runs, topicRefs);
}

// Distinct matched sections for a topic, in reading order (topic-level match first).
function sectionsForTopic(match) {
  if (!match) return [];
  const seen = new Set();
  return [match.topic, ...match.subtopics.map((s) => s.section)].filter((s) => s && !seen.has(s.id) && seen.add(s.id));
}

// Real book text for the generation prompt: the section's own intro/key idea/book examples.
function sectionSourceText(section) {
  const head = `[${section.title} — Grade ${section.grade}${section.chapterTitle ? `, chapter "${section.chapterTitle}"` : ''}, page ${section.page}]`;
  if (section.tutor) {
    const t = section.tutor;
    const examples = (t.examples || []).map((e) => `Example: ${e.problem}\n${(e.steps || []).map((s) => `- ${s.say}${s.show ? ` (${s.show})` : ''}`).join('\n')}\nAnswer: ${e.answer}`).join('\n');
    return [head, t.intro, t.keyIdea && `Key idea: ${t.keyIdea}`, examples].filter(Boolean).join('\n');
  }
  const blocks = section.learn?.blocks || [];
  const text = blocks.map((b) => b.text || (Array.isArray(b.items) ? b.items.map((i) => (typeof i === 'string' ? i : `${i.term || i.name || ''}: ${i.definition || i.description || ''}`)).join('; ') : '')).filter(Boolean).join('\n');
  return [head, text].filter(Boolean).join('\n');
}

// The book's own worked examples (maths only) — real textbook material, tagged SOURCE_DERIVED.
function sectionWorkedExamples(section) {
  if (!section.tutor) return [];
  return require('../curriculum/bookSections').mathsLearnBlocks(section.tutor).filter((b) => b.type === 'worked_example')
    .map((b) => ({ ...b, concept: section.title, exampleType: 'SOURCE_DERIVED', bookPage: section.page }));
}

// Book pane data: opens at the first matched section; `pages` lets the teacher/student jump per subtopic.
function bookForTopic(match, sections) {
  if (!sections.length) return null;
  const first = sections[0];
  const pageOf = (s) => ({ pdfFile: s.pdfFile, bookPath: s.bookPath, bookTitle: s.bookTitle, chapterTitle: s.chapterTitle, grade: s.grade, pdfPage: s.page, section: s.title });
  return {
    pdfFile: first.pdfFile, bookPath: first.bookPath, bookTitle: first.bookTitle,
    chapterTitle: first.chapterTitle || first.title, pdfPage: first.page, grade: first.grade, confidence: 10,
    pages: match.subtopics.map((s) => ({ subtopic: s.title, ...(s.section ? pageOf(s.section) : { pdfFile: null }) })),
  };
}

module.exports = { loadBookSections, matchTopicsToBook, sectionsForTopic, sectionSourceText, sectionWorkedExamples, bookForTopic, buildMatchPrompt, parseMatch, voteMatches };
