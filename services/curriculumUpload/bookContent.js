const { callWithFallback } = require('../llm/fallback');
const { gradeCalibrationNote } = require('../curriculum/gradeCalibration');
const { normalizeQuizQuestion } = require('../quizNormalize');
const { sectionsForTopic, bookForTopic } = require('./bookMatch');

// Builds a teacher topic's Learn / Listen / Practice from the pre-built book sections it was matched to — no AI
// for those parts. Only subtopics the book does not teach get one small AI call each, clearly labelled.

const GAP_CONCURRENCY = 2;
const MAX_WHAT_YOULL_LEARN = 5;

function header(section) {
  return { type: 'explanation', text: `From the book: ${section.title} (Grade ${section.grade}${section.bookTitle ? `, ${section.bookTitle}` : ''}, page ${section.page})` };
}

function mathsLearn(section) {
  const t = section.tutor;
  return [
    ...(t.intro ? [{ type: 'overview', text: t.intro }] : []),
    ...(t.keyIdea ? [{ type: 'key_points', items: [t.keyIdea] }] : []),
    ...(t.examples || []).map((e) => ({
      type: 'worked_example',
      concept: e.title || section.title,
      problem: e.problem,
      steps: (e.steps || []).map((s) => ({ explanation: s.say, calculation: s.show || '' })),
      finalAnswer: e.answer,
      exampleType: 'SOURCE_DERIVED',
      bookPage: e.page || section.page,
    })),
  ];
}

function sectionLearn(section) {
  const blocks = section.tutor ? mathsLearn(section) : (section.learn?.blocks || []);
  return blocks.length ? [header(section), ...blocks] : [];
}

function sectionWhatYoullLearn(section) {
  if (section.tutor) return section.tutor.keyIdea ? [section.tutor.keyIdea] : [];
  return section.learn?.whatYoullLearn || [];
}

function sectionListen(section) {
  if (section.tutor) {
    const t = section.tutor;
    return (t.examples || []).map((e, i) => ({
      heading: e.title || section.title,
      text: [i === 0 ? t.intro : '', e.problem, ...(e.steps || []).map((s) => s.say), e.answer ? `So the answer is ${e.answer}.` : '']
        .filter(Boolean).join(' '),
      keyIdea: e.why || t.keyIdea || '',
    })).filter((p) => p.text);
  }
  return (section.listen || []).map((p, i, all) => ({
    heading: all.length > 1 ? `${section.title} (${i + 1})` : section.title,
    text: p.text || (p.lines || []).map((l) => l.text).join(' '),
    keyIdea: '',
  })).filter((p) => p.text);
}

function sectionPractice(section) {
  if (section.tutor) {
    return (section.tutor.examples || []).filter((e) => e.yourTurn?.question && e.yourTurn?.answer)
      .map((e) => normalizeQuizQuestion({ type: 'fill_blank', question: e.yourTurn.question, correct: e.yourTurn.answer, hint: e.hint, explanation: e.why }));
  }
  return (section.quiz || []).filter((q) => q.question && Array.isArray(q.options))
    .map((q) => normalizeQuizQuestion({ type: 'mcq', question: q.question, options: q.options, correct: q.correctIndex ?? q.correct ?? 0, explanation: q.explanation }));
}

function buildGapPrompt(gap, ref, metadata) {
  const grade = metadata?.grade;
  const calibration = gradeCalibrationNote(grade);
  return `You are teaching ONE subtopic to a Grade ${grade} ${metadata?.subject || ''} student (${metadata?.curriculum || 'CBSE'} / NCERT).
Subtopic: "${gap}" (part of the topic "${ref.topicTitle}").
The textbook does not cover it, so teach it correctly from standard, well-established Grade ${grade} knowledge. Every fact and every calculation must be exactly right. Use a real-life Indian context for the example.
${calibration ? `${calibration}\n` : ''}
Respond with ONLY JSON:
{"explanation": "3-5 short sentences", "example": "one example with its worked answer", "listen": "4-6 spoken sentences explaining it to the student", "questions": [{"question": "...", "options": ["...", "...", "...", "..."], "correctIndex": 0, "explanation": "..."}, {"question": "...", "options": ["...", "...", "...", "..."], "correctIndex": 0, "explanation": "..."}]}`;
}

// One small AI call per uncovered subtopic. Returns null on any failure — the topic then just lacks that part.
async function gapLesson(gap, ref, metadata) {
  let parsed;
  try {
    parsed = JSON.parse(await callWithFallback(buildGapPrompt(gap, ref, metadata), { json: true, temperature: 0.3 }));
  } catch (err) {
    console.error(`[bookContent] gap lesson failed for "${gap}":`, err.message);
    return null;
  }
  if (typeof parsed?.explanation !== 'string' || !parsed.explanation.trim()) return null;
  return {
    blocks: [
      { type: 'explanation', text: `Not in the book, explained by AI (please check): ${gap}`, aiWritten: true },
      { type: 'explanation', text: parsed.explanation, aiWritten: true },
      ...(typeof parsed.example === 'string' && parsed.example.trim() ? [{ type: 'example', text: parsed.example, aiWritten: true }] : []),
    ],
    listen: typeof parsed.listen === 'string' && parsed.listen.trim() ? [{ heading: gap, text: parsed.listen, keyIdea: '' }] : [],
    practice: (Array.isArray(parsed.questions) ? parsed.questions : [])
      .filter((q) => q?.question && Array.isArray(q.options) && q.options.length >= 2)
      .map((q) => normalizeQuizQuestion({ type: 'mcq', question: q.question, options: q.options, correct: Number(q.correctIndex) || 0, explanation: q.explanation })),
  };
}

async function mapLimited(items, limit, fn) {
  const out = new Array(items.length);
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) { const i = next++; out[i] = await fn(items[i]); }
  }));
  return out;
}

// Topic content in subtopic order: each matched section once, then an AI part for each uncovered subtopic.
async function assembleBookTopic(ref, match, metadata) {
  const sections = sectionsForTopic(match);
  const gaps = match.subtopics.filter((s) => !(s.sections?.length || s.section)).map((s) => s.title);
  const gapResults = await mapLimited(gaps, GAP_CONCURRENCY, (g) => gapLesson(g, ref, metadata));
  const gapLessons = gapResults.filter(Boolean);

  const blocks = [...sections.flatMap(sectionLearn), ...gapLessons.flatMap((g) => g.blocks)];
  const whatYoullLearn = [...new Set(sections.flatMap(sectionWhatYoullLearn))].slice(0, MAX_WHAT_YOULL_LEARN);
  const tutors = sections.filter((s) => s.tutor);
  return {
    // Same shape the student AI Tutor board plays (one step per book example).
    ...(tutors.length ? {
      mathTutor: {
        intro: tutors[0].tutor.intro || '',
        keyIdea: tutors[0].tutor.keyIdea || '',
        examples: tutors.flatMap((s) => (s.tutor.examples || []).map((e) => ({ ...e, page: e.page || s.page }))),
      },
    } : {}),
    whatYoullLearn: whatYoullLearn.length ? whatYoullLearn : [`Understand ${ref.topicTitle}`],
    blocks,
    listenParts: [...sections.flatMap(sectionListen), ...gapLessons.flatMap((g) => g.listen)],
    practiceQuiz: [...sections.flatMap(sectionPractice), ...gapLessons.flatMap((g) => g.practice)],
    book: bookForTopic(match, sections),
    aiWrittenSubtopics: gaps.filter((_, i) => gapResults[i]),
    missingSubtopics: gaps.filter((_, i) => !gapResults[i]),
  };
}

module.exports = { assembleBookTopic, sectionLearn, sectionListen, sectionPractice, gapLesson, buildGapPrompt };
