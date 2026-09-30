const { retrieveGroundingContext } = require('./groundedContent');
const { validateBlock } = require('../curriculum/blockSchema');
const { gradeCalibrationNote } = require('../curriculum/gradeCalibration');
const { verifyWorkedExample, verifyCalculationString } = require('./mathValidator');
const { buildQuizPrompt } = require('../curriculum/quizPrompt');
const { normalizeQuizQuestion } = require('../quizNormalize');
const { findTopicImages } = require('../qdrant');
const { checkGradeFit } = require('../curriculum/gradeFit');
const { callWithFallback } = require('../llm/fallback');
const { buildCacheKey, getCachedTopic, persistCachedTopic, dedupeGeneration } = require('./topicCache');
const { matchTopicsToBook, loadBookSections, sectionsForTopic, matchUnits } = require('./bookMatch');
const { assembleBookTopic } = require('./bookContent');
const { usesNcertBooks } = require('./curriculumKind');

// Lazy — enrichment.js constructs its own Groq/Supabase clients at module
// load, which crashes under jest.requireActual in tests that only need this
// file's error classes. Requiring it on first real use avoids that entirely.
let _enrichment = null;
function getEnrichment() {
  if (!_enrichment) _enrichment = require('../curriculum/enrichment');
  return _enrichment;
}

class LearningPathGenerationError extends Error {}

const MAX_SOURCE_CONTEXT_CHARS = 1500;

// Bounds per-draft LLM concurrency so a many-topic upload doesn't burst
// Groq's TPM limit — small concurrency instead of unbounded Promise.all.
const DRAFT_CONCURRENCY = 2;
async function mapWithConcurrency(items, limit, fn) {
  const results = new Array(items.length);
  let next = 0;
  async function worker() {
    while (next < items.length) {
      const i = next++;
      results[i] = await fn(items[i], i);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}

function collectTopicRefs(normalized) {
  const refs = [];
  normalized.units.forEach((unit) => {
    unit.topics.forEach((topic) => {
      if (!topic.title) return;
      const sourceContext = (topic.content || []).join(' ').trim().slice(0, MAX_SOURCE_CONTEXT_CHARS);
      refs.push({
        unitOrder: unit.order,
        topicOrder: topic.order,
        unitTitle: unit.title,
        topicTitle: topic.title,
        subtopics: topic.subtopics.map((s) => s.title).filter(Boolean),
        sourceContext,
      });
    });
  });
  return refs;
}

// Reuses the same enrichment.js block types the student Learn tab already
// renders (worked_example, example, process, comparison, explanation) —
// LearningBlocks.tsx never needs to change for teacher-generated content to
// display there. A topic with no example-shaped block still gets one real
// lesson from its explanation/overview rather than an empty lessons array.
function deriveObjectivesAndLessons(whatYoullLearn, blocks) {
  const objectives = Array.isArray(whatYoullLearn) ? whatYoullLearn : [];
  const lessons = [];

  for (const block of blocks) {
    if (block.type === 'worked_example') {
      lessons.push({
        title: block.concept || 'Worked Example',
        summary: `${block.problem}\n${block.steps
          .map((s, idx) => {
            const explanation = s.explanation || s.action || '';
            const calculation = s.calculation || s.equation || '';
            return `${idx + 1}. ${explanation}${calculation ? ` (${calculation})` : ''}`;
          })
          .join('\n')}\nFinal answer: ${block.finalAnswer}`,
      });
    } else if (block.type === 'example') {
      lessons.push({ title: 'Example', summary: block.text });
    } else if (block.type === 'process') {
      lessons.push({ title: block.title || 'Process', summary: block.steps.join(' -> ') });
    } else if (block.type === 'comparison') {
      lessons.push({ title: block.title || 'Comparison', summary: block.items.map((i) => `${i.name}: ${i.description}`).join('; ') });
    }
  }

  if (lessons.length === 0) {
    const prose = blocks.find((b) => b.type === 'explanation' || b.type === 'overview');
    if (prose) lessons.push({ title: 'Explanation', summary: prose.text });
  }

  return { objectives, lessons };
}

// generateStructuredContent (services/curriculum/enrichment.js) is shared
// with the student Learn tab and deliberately omits a worked_example block
// rather than fabricate one when the source has no worked problem in it —
// true for every currently-ingested NCERT chunk (chapter-summary/keyword
// text only, confirmed via direct Qdrant query). Teacher-curriculum math
// topics still need an example, so this makes ONE additional targeted Groq
// call — reusing the same client/model-fallback path, not a new pipeline —
// asking specifically for a worked_example grounded in the retrieved
// context's named method/key-terms.
//
// The numeric problem itself is necessarily invented (the source has no
// worked problem to draw one from) — arithmetic correctness is verified,
// but the NUMBERS are not NCERT-sourced. Per the anti-hallucination rule
// applied everywhere else in this file (see GAP_RESOLUTION_NOTE below:
// "do NOT invent curriculum material ... to fill the gap"), this must never
// be presented to a student as if it came from the textbook. The block is
// tagged `synthetic: true` so callers/UI can render it as a clearly-labeled
// AI-generated practice example rather than indistinguishable NCERT content.
// Failure here never fails the topic — it just means no worked example.
function buildWorkedExamplePrompt(topicRef, metadata, retrievedContext, arithmeticErrors) {
  const base = `You are creating ONE worked mathematical PRACTICE example for a student learning "${topicRef.topicTitle}"${metadata?.grade ? ` (Grade ${metadata.grade})` : ''}.

SOURCE MATERIAL (use its named method/technique — do not use a different method):
"${retrievedContext}"

This problem's numbers are NOT taken from the source material (the source describes the method but contains no worked numeric problem) — you are creating an illustrative AI-generated practice problem that applies the same method. Write one concrete numeric problem that applies the method described above, and solve it step by step with fully correct arithmetic (double-check every calculation before answering).

Each step MUST include a "calculation" field written as a checkable arithmetic equality (e.g. "12 + 8 = 20"), not prose — this is machine-verified after you respond, so it must be exact.

Respond with ONLY a JSON object of this exact shape:
{"type":"worked_example","problem":"...","concept":"...","steps":[{"step_number":1,"explanation":"...","calculation":"12 + 8 = 20"}],"finalAnswer":"...","check":"..."}`;

  if (!arithmeticErrors) return base;
  return `${base}\n\nYour previous response had incorrect arithmetic in these steps: ${JSON.stringify(arithmeticErrors)}. Recompute carefully and respond again with the corrected JSON object, same shape.`;
}

// synthetic:true / exampleType:'GROUNDED_SYNTHETIC' are applied here, not
// requested of the model — a required hallucination-disclosure flag must not
// depend on the model choosing to include it. `synthetic: true` is kept
// alongside the new taxonomy field for frontend backward-compat (see
// adaptTeacherContent.ts / LearningBlocks.tsx, which already read it).
//
// Arithmetic is deterministically re-checked (mathValidator.js) rather than
// trusted from the model — one retry on failure, reusing the same
// schema-validation retry pattern used elsewhere in this file. A block that
// still fails verification after the retry is dropped (returns null) rather
// than ever being tagged GROUNDED_SYNTHETIC/SOURCE_DERIVED with wrong
// arithmetic — the caller already treats null as "no worked example this
// round", never a silent bad-content save.
async function generateWorkedExample(topicRef, metadata, retrievedContext) {
  let arithmeticErrors = null;

  for (let attempt = 1; attempt <= 2; attempt += 1) {
    const prompt = buildWorkedExamplePrompt(topicRef, metadata, retrievedContext, arithmeticErrors);

    let completion;
    try {
      completion = await callGroq(prompt);
    } catch (err) {
      return null;
    }

    let block;
    try {
      block = JSON.parse(completion.choices?.[0]?.message?.content || '');
    } catch (err) {
      return null;
    }

    if (!validateBlock(block)) return null;

    const verification = verifyWorkedExample(block);
    if (verification.valid) {
      return { ...block, synthetic: true, exampleType: 'GROUNDED_SYNTHETIC' };
    }
    if (attempt === 2) return null; // still wrong after retry — never save as correct
    arithmeticErrors = verification.failures;
  }
  return null;
}

// Shared post-processing for any generateStructuredContent result, whichever
// path produced it (Qdrant-grounded or model-knowledge): worked-example
// exampleType tagging, math worked-example fill-in, and objectives/lessons
// derivation. Keeps groundTopic and the knowledge-tier path from duplicating
// this logic.
async function finalizeGeneratedTopic(topicRef, metadata, generated, contentType, groundingSource, groundedContext) {
  // model_knowledge topics have no real source text — any worked_example the
  // LLM wrote is authored, never textbook-derived, so it must always be
  // disclosed as synthetic (never mislabeled SOURCE_DERIVED).
  generated.blocks = generated.blocks.map((b) => {
    if (b.type !== 'worked_example') return b;
    if (groundingSource === 'model_knowledge') return { ...b, exampleType: 'GROUNDED_SYNTHETIC', synthetic: true };
    return !b.exampleType ? { ...b, exampleType: 'SOURCE_DERIVED' } : b;
  });

  // Textbook images: filtered grade+subject+chapter, ranked by keyword
  // overlap with the topic/subtopics/key terms. Done for every topic,
  // including model_knowledge ones. No match -> no image, the recipe's own
  // structured visual block (table/process/...) stands in instead.
  const keyTerms = (generated.blocks.find((b) => b.type === 'key_terms')?.items || []).map((i) => i.term).filter(Boolean);
  const chapterMatch = matchChapter(topicRef, metadata);
  const book = chapterMatch && { pdfFile: chapterMatch.pdfFile, bookPath: chapterMatch.bookPath, bookTitle: chapterMatch.book, chapterTitle: chapterMatch.title, pdfPage: 1, confidence: chapterMatch.confidence };
  const images = !usesNcertBooks(metadata) ? [] : await findTopicImages({
    grade: metadata?.grade,
    subject: metadata?.subject,
    pdfFile: book?.pdfFile || null,
    topicTitle: topicRef.topicTitle,
    subtopics: topicRef.subtopics,
    keyTerms,
  }).catch(() => []);
  if (images.length) {
    generated.blocks = [...generated.blocks, ...images.map((img) => ({ type: 'image', url: img.url, caption: img.caption, alt_text: img.caption }))];
  }

  if (contentType === 'mathematics' && !generated.blocks.some((b) => b.type === 'worked_example')) {
    const context = groundedContext?.context || topicRef.sourceContext || topicRef.topicTitle;
    const workedExample = await generateWorkedExample(topicRef, metadata, context);
    if (workedExample) generated.blocks = [...generated.blocks, workedExample];
  }

  const { objectives, lessons } = deriveObjectivesAndLessons(generated.whatYoullLearn, generated.blocks);
  const mathTutor = contentType === 'mathematics' ? tutorFromBlocks(generated.blocks) : null;
  return {
    unitOrder: topicRef.unitOrder,
    topicOrder: topicRef.topicOrder,
    objectives,
    lessons,
    // Both grounded and model-knowledge topics have real content by
    // construction, so they're always "ready" — needs_teacher_input only
    // applies to topics that failed both grounding and knowledge generation.
    status: 'ready',
    teacherHint: null,
    content: {
      whatYoullLearn: generated.whatYoullLearn, blocks: generated.blocks, contentType,
      ...(book ? { book } : {}),
      ...(mathTutor ? { mathTutor } : {}),
    },
    groundingSource,
  };
}

// Condenses finished Learn blocks into plain text so the companions prompt
// (and the quiz's passageText grounding) is based ONLY on approved content.
function blocksToText(blocks) {
  return (blocks || [])
    .map((b) => {
      if (b.type === 'worked_example') {
        const steps = (b.steps || []).map((s) => `${s.explanation || s.action || ''} ${s.calculation || s.equation || ''}`).join('\n');
        return `Worked Example: ${b.problem}\n${steps}\nAnswer: ${b.finalAnswer}`;
      }
      if (b.type === 'example') return `Example: ${b.text}`;
      if (b.type === 'process') return `${b.title || 'Process'}: ${(b.steps || []).join(' -> ')}`;
      if (b.type === 'comparison') return `${b.title || 'Comparison'}: ${(b.items || []).map((i) => `${i.name}: ${i.description}`).join('; ')}`;
      return b.text || '';
    })
    .filter(Boolean)
    .join('\n\n')
    .slice(0, MAX_SOURCE_CONTEXT_CHARS * 2);
}

// listenParts/practiceQuiz prompt — one call, grounded ONLY in the finished
// Learn content passed in, so audio/practice can't drift from what the
// teacher approved. practiceQuiz reuses buildQuizPrompt's exact question
// spec (shared with routes/ibpyp.js) so the shape matches what the student
// Quiz screen already consumes.
function buildCompanionsPrompt(topicRef, metadata, content, isMath) {
  const blocksText = blocksToText(content.blocks);
  const objectives = (content.whatYoullLearn || []).join('; ');
  const calibrationNote = gradeCalibrationNote(metadata?.grade);

  const listenInstructions = isMath
    ? 'For "listenParts": act as a patient AI Tutor. Walk through EACH worked example in the Learn content below step by step, explaining the reasoning out loud like a tutor sitting beside the student (one listenPart per worked example, plus a short intro part).'
    : 'For "listenParts": write a spoken, conversational explanation of the Learn content below, as if narrating it aloud to the student. Break it into natural sections, short sentences.';

  const mathCalcRule = isMath
    ? '\nAdditionally, for each fill_blank question, include a "calculation" field like the worked example steps (e.g. "12 + 8 = 20") showing the arithmetic that produces the correct answer — this is machine-verified.'
    : '';

  const quizSpec = buildQuizPrompt({
    topic: topicRef.topicTitle,
    grade: metadata?.grade,
    subject: metadata?.subject,
    curriculum: metadata?.curriculum,
    passageText: blocksText,
  });

  return `You are creating an audio script and a practice quiz for a Learn lesson the student has ALREADY been shown below. Base BOTH parts ONLY on this content — do not introduce facts not in it.

${calibrationNote ? `${calibrationNote}\n\n` : ''}LEARN CONTENT:
Objectives: ${objectives || '(none)'}
${blocksText}

${listenInstructions}
Each listenPart needs: "heading", "text" (spoken-aloud script), "keyIdea" (one sentence), and "pauseThink": {"question": string, "options": string[4], "correctIndex": number}.

For "practiceQuiz" (JSON key "questions"), follow this exact question specification:
${quizSpec}${mathCalcRule}

Respond with ONLY ONE JSON object of this exact shape:
{"listenParts": [{"heading":"...","text":"...","keyIdea":"...","pauseThink":{"question":"...","options":["...","...","...","..."],"correctIndex":0}}], "questions": [...same shape as specified above...]}`;
}

function isValidPracticeQuestion(q, isMath) {
  if (!isMath || q.type !== 'fill_blank' || !q.calculation) return true;
  const { checked, valid } = verifyCalculationString(q.calculation);
  return !checked || valid;
}

async function generateCompanions(topicRef, metadata, content) {
  const isMath = content?.contentType === 'mathematics';
  const prompt = buildCompanionsPrompt(topicRef, metadata, content, isMath);

  let completion;
  try {
    completion = await callGroq(prompt);
  } catch {
    return null;
  }

  let parsed;
  try {
    parsed = JSON.parse(completion.choices?.[0]?.message?.content || '');
  } catch {
    return null;
  }

  const listenParts = (Array.isArray(parsed.listenParts) ? parsed.listenParts : [])
    .filter((p) => p && typeof p.heading === 'string' && typeof p.text === 'string')
    .map((p) => ({
      heading: p.heading,
      text: p.text,
      keyIdea: typeof p.keyIdea === 'string' ? p.keyIdea : '',
      ...(p.pauseThink && typeof p.pauseThink.question === 'string' && Array.isArray(p.pauseThink.options)
        ? { pauseThink: { question: p.pauseThink.question, options: p.pauseThink.options.map(String), correctIndex: Number(p.pauseThink.correctIndex) || 0 } }
        : {}),
    }));

  const practiceQuiz = (Array.isArray(parsed.questions) ? parsed.questions : [])
    .filter((q) => isValidPracticeQuestion(q, isMath))
    .map(normalizeQuizQuestion);

  if (listenParts.length === 0 && practiceQuiz.length === 0) return null;
  return { listenParts, practiceQuiz };
}

// A topic matched to book sections: Learn/Listen/Practice come straight from the pre-built book content;
// only subtopics the book does not teach get a small AI part (see bookContent.js).
async function bookTopic(topicRef, metadata) {
  const { classifyContentType } = getEnrichment();
  const { missingSubtopics, ...content } = await assembleBookTopic(topicRef, topicRef.bookMatch, metadata);
  const { objectives, lessons } = deriveObjectivesAndLessons(content.whatYoullLearn, content.blocks);
  return {
    unitOrder: topicRef.unitOrder,
    topicOrder: topicRef.topicOrder,
    objectives,
    lessons,
    status: missingSubtopics.length ? 'needs_teacher_input' : 'ready',
    teacherHint: missingSubtopics.length
      ? `Not in the book and the AI could not write it just now: ${missingSubtopics.join(', ')}. Add it yourself or pick a book page.`
      : null,
    content: { ...content, contentType: classifyContentType(metadata?.subject) },
    groundingSource: 'ncert_book',
  };
}

// The student AI Tutor board plays one step per worked example: built from the lesson's own worked examples.
function tutorFromBlocks(blocks) {
  const examples = blocks.filter((b) => b.type === 'worked_example' && b.problem && b.finalAnswer).map((b) => ({
    title: b.concept || 'Example',
    problem: b.problem,
    steps: (b.steps || []).map((s) => ({ say: s.explanation || s.action || '', show: s.calculation || s.equation || '' })).filter((s) => s.say),
    answer: b.finalAnswer,
  })).filter((e) => e.steps.length);
  if (!examples.length) return null;
  const intro = blocks.find((b) => b.type === 'overview' || b.type === 'explanation')?.text || '';
  const keyIdea = blocks.find((b) => b.type === 'key_points')?.items?.[0] || '';
  return { intro, keyIdea: typeof keyIdea === 'string' ? keyIdea : '', examples };
}

// Reference text of a matched book section for writing a lesson — the content only, never the book's name or pages.
function sectionReferenceText(section) {
  if (section.tutor) {
    const t = section.tutor;
    const examples = (t.examples || []).map((e) => `Example: ${e.problem}\n${(e.steps || []).map((s) => `- ${s.say}${s.show ? ` (${s.show})` : ''}`).join('\n')}\nAnswer: ${e.answer}`);
    return [t.intro, t.keyIdea && `Key idea: ${t.keyIdea}`, ...examples].filter(Boolean).join('\n');
  }
  return (section.learn?.blocks || []).map((b) => b.text || (Array.isArray(b.items) ? b.items.map((i) => (typeof i === 'string' ? i : `${i.term || i.name || ''}: ${i.definition || i.description || ''}`)).join('; ') : '')).filter(Boolean).join('\n');
}

const MAX_REFERENCE_CHARS = 7000;
const MAX_SUBTOPIC_SEARCHES = 5;

// A topic of a curriculum without its own books here (IB, ...): the lesson is written from whatever reference material
// matches best — book sections of any curriculum and the vector store — plus the teacher's own notes, in a neutral
// voice. null when nothing matched (the caller then falls back to AI knowledge, labelled for the teacher).
async function openTopic(topicRef, metadata, qualityFeedback) {
  const sources = (topicRef.bookSections || []).map(sectionReferenceText).filter(Boolean);
  // One search for the topic and one per subtopic: a single combined query drifted to neighbouring topics.
  const queries = [{ topic: topicRef.topicTitle, subtopics: [] }, ...topicRef.subtopics.slice(0, MAX_SUBTOPIC_SEARCHES).map((s) => ({ topic: `${s} (${topicRef.topicTitle})`, subtopics: [] }))];
  const found = await mapWithConcurrency(queries, 2, (q) => retrieveGroundingContext({
    curriculum: metadata?.curriculum, grade: metadata?.grade, subject: metadata?.subject, ...q,
  }).catch(() => null));
  for (const r of found) if (r?.context && !sources.includes(r.context)) sources.push(r.context);
  if (!sources.length) return null;

  const { generateStructuredContent, classifyContentType } = getEnrichment();
  const contentType = classifyContentType(metadata?.subject);
  const primaryText = sources.join('\n\n').slice(0, MAX_REFERENCE_CHARS);
  const generated = await generateStructuredContent({
    curriculum: metadata?.curriculum,
    grade: metadata?.grade,
    subject: metadata?.subject,
    topic: topicRef.subtopics.length ? `${topicRef.topicTitle} (cover: ${topicRef.subtopics.join('; ')})` : topicRef.topicTitle,
    chapterPdf: null,
    primaryText,
    contextText: topicRef.sourceContext ? `Teacher's notes: ${topicRef.sourceContext}` : '',
    contentType,
    qualityFeedback,
    neutralSource: true,
    mustCover: topicRef.subtopics,
  });
  if (!generated.ok) return null;
  return finalizeGeneratedTopic(topicRef, metadata, generated, contentType, 'reference_sources', { context: primaryText });
}

async function groundTopic(topicRef, metadata, qualityFeedback) {
  if (!usesNcertBooks(metadata)) return openTopic(topicRef, metadata, qualityFeedback);
  const retrieved = await retrieveGroundingContext({
    curriculum: metadata?.curriculum,
    grade: metadata?.grade,
    subject: metadata?.subject,
    topic: topicRef.topicTitle,
    subtopics: topicRef.subtopics,
  });
  if (!retrieved) return null;

  const { generateStructuredContent, classifyContentType } = getEnrichment();
  const contentType = classifyContentType(metadata?.subject);
  const generated = await generateStructuredContent({
    curriculum: metadata?.curriculum || 'CBSE',
    grade: metadata?.grade,
    subject: metadata?.subject,
    topic: topicRef.topicTitle,
    chapterPdf: null,
    primaryText: retrieved.context,
    contextText: '',
    contentType,
    qualityFeedback,
  });
  if (!generated.ok) return null;

  // Any worked_example enrichment.js already produced came straight from the
  // retrieved NCERT text (it deliberately omits the block otherwise — see
  // enrichment.js's COMMON_RULES rule 7) — SOURCE_DERIVED tagging happens in
  // finalizeGeneratedTopic, distinct from the invented-but-verified
  // GROUNDED_SYNTHETIC one generateWorkedExample() produces.
  return finalizeGeneratedTopic(topicRef, metadata, generated, contentType, 'ncert_vector', retrieved);
}

const CHAPTER_MATCH_STOPWORDS = new Set(['and', 'the', 'of', 'in', 'to', 'a', 'for', 'with', 'on', 'is', 'are', 'an', 'as', 'from', 'this', 'that', 'it', 'our', 'your']);
function stemWord(w) { return w.length > 4 && w.endsWith('s') ? w.slice(0, -1) : w; }
function chapterWords(text) {
  return new Set(String(text || '').toLowerCase().match(/[a-z]{3,}/g)?.filter((w) => !CHAPTER_MATCH_STOPWORDS.has(w)).map(stemWord) || []);
}

// Maps a teacher topic to an NCERT registry chapter by keyword overlap
// (title words weighted double, subtopic words single), NOT by position —
// teacher docx units rarely follow the textbook's own chapter order, and a
// positional guess was attaching the wrong chapter's title/images (e.g.
// "Understanding Fractions" landing on ch2 "Lines and Angles" instead of
// ch7 "Fractions"). Returns null below the confidence threshold rather than
// guessing — e.g. an old-syllabus topic ("Knowing Our Numbers") with no
// clean match in the current book must stay unmatched, not land on a
// random chapter that happens to share a generic word like "number".
function matchChapter(topicRef, metadata) {
  if (!usesNcertBooks(metadata)) return null;
  let chapters;
  try {
    chapters = require('../syllabus-map').chaptersFor(metadata?.grade, metadata?.subject);
  } catch {
    return null;
  }
  if (!chapters.length) return null;

  const titleWords = chapterWords([topicRef.topicTitle, topicRef.unitTitle].join(' '));
  const allWords = chapterWords([topicRef.topicTitle, topicRef.unitTitle, ...(topicRef.subtopics || [])].join(' '));
  if (allWords.size === 0) return null;

  let best = null;
  for (const ch of chapters) {
    const chTitleWords = chapterWords(ch.title);
    const chSubWords = chapterWords((ch.subtopics || []).map((s) => s.title).join(' '));
    const titleOverlap = [...titleWords].filter((w) => chTitleWords.has(w)).length;
    const subOverlap = [...allWords].filter((w) => chSubWords.has(w)).length;
    const score = titleOverlap * 2 + subOverlap;
    if (!best || score > best.score) best = { ch, score };
  }

  const CONFIDENCE_THRESHOLD = 4;
  if (!best || best.score < CONFIDENCE_THRESHOLD) return null;
  return {
    chapter: best.ch.chapter,
    pdfFile: best.ch.pdfFile,
    title: best.ch.title,
    bookPath: best.ch.bookPath,
    book: best.ch.book,
    confidence: best.score,
  };
}

// Chapter title for the knowledge prompt: prefer the unit title from the
// upload itself, else the keyword-matched registry chapter.
function resolveChapterTitle(topicRef, metadata) {
  if (topicRef.unitTitle) return topicRef.unitTitle;
  const match = matchChapter(topicRef, metadata);
  return match?.title || topicRef.topicTitle;
}

// Chapter pdfFile (e.g. "fecu105.pdf") for the image lookup — same keyword
// match as resolveChapterTitle (never positional), just the book-code field.
function resolveChapterPdf(topicRef, metadata) {
  return matchChapter(topicRef, metadata)?.pdfFile || null;
}

// Knowledge tier: for a topic Qdrant couldn't ground, ask the model to write
// from its own knowledge, anchored to the chapter registry. Only an
// {"unknown":true} answer or a failure falls through to needs_teacher_input.
async function knowledgeTopic(topicRef, metadata, qualityFeedback) {
  const { generateStructuredContent, classifyContentType } = getEnrichment();
  const contentType = classifyContentType(metadata?.subject);
  const chapterMatch = matchChapter(topicRef, metadata);
  // Only claim a real chapter match when the registry actually confirms one —
  // an unmatched topic (e.g. an old-syllabus title) still gets taught from the
  // unit/topic/subtopics themselves, not bailed on for "not in chapter X".
  const chapterTitle = chapterMatch?.title || topicRef.unitTitle || topicRef.topicTitle;

  let generated;
  try {
    generated = await generateStructuredContent({
      mode: 'knowledge',
      curriculum: metadata?.curriculum || 'CBSE',
      grade: metadata?.grade,
      subject: metadata?.subject,
      chapterTitle,
      chapterMatched: !!chapterMatch,
      unitTitle: topicRef.unitTitle,
      topic: topicRef.topicTitle,
      subtopics: topicRef.subtopics,
      contentType,
      qualityFeedback,
      neutralSource: !usesNcertBooks(metadata),
      mustCover: usesNcertBooks(metadata) ? undefined : topicRef.subtopics,
    });
  } catch {
    return null;
  }
  if (!generated?.ok) return null;

  return finalizeGeneratedTopic(topicRef, metadata, generated, contentType, 'model_knowledge', null);
}

// gradeCalibrationNote now lives in ../curriculum/gradeCalibration.js — shared
// with enrichment.js's buildPrompt (the GROUNDED path) so both generation
// paths get the same 4-tier calibration instead of only this batch-fallback
// path having it.

// Anti-hallucination gap-resolution protocol: a topic whose only source is a
// bare title/vague bullet must not be padded out with invented curriculum
// material — it should be flagged for the teacher instead. Applies to this
// batch path specifically because it has no vector-retrieved grounding to
// fall back on; the grounded path (groundTopic) never reaches here at all.
const GAP_RESOLUTION_NOTE = `GAP RESOLUTION: For each topic, if its "Source text" (or subtopics) gives enough detail to write real objectives and lessons, set "status":"ready" and "teacherHint":null. If the topic has only a bare title or a vague bullet with no usable detail, do NOT invent curriculum material to fill the gap — set "status":"needs_teacher_input", write minimal/generic objectives and an empty lessons array, and set "teacherHint" to a specific, actionable prompt telling the teacher what to add (e.g. "The uploaded document lists 'Quadrilaterals' with no subtopics — specify whether this covers area formulas, angle sums, or proofs.").`;

function buildPrompt(topicRefs, metadata, previousErrors) {
  const metadataNote = metadata && (metadata.grade || metadata.subject || metadata.curriculum)
    ? `CURRICULUM CONTEXT: ${[metadata.curriculum, metadata.subject, metadata.grade ? `Grade ${metadata.grade}` : null].filter(Boolean).join(', ')}\n\n`
    : '';
  const calibrationNote = gradeCalibrationNote(metadata?.grade);

  const topicList = topicRefs
    .map((t) => {
      const subtopicNote = t.subtopics.length ? ` (subtopics: ${t.subtopics.join(', ')})` : '';
      const contextNote = t.sourceContext ? `\n  Source text: "${t.sourceContext}"` : '';
      return `- unitOrder=${t.unitOrder}, topicOrder=${t.topicOrder}: "${t.unitTitle || ''}" > "${t.topicTitle}"${subtopicNote}${contextNote}`;
    })
    .join('\n');

  const base = `You are writing learning-path content for an EXISTING curriculum outline. You must NOT invent new topics, units or subtopics — only add learning objectives and a lesson breakdown for the topics listed below, using their exact unitOrder/topicOrder pairs. Ground every objective and lesson in that topic's own "Source text" — never fall back to generic subject knowledge when source text is given.

${calibrationNote ? `${calibrationNote}\n\n` : ''}${GAP_RESOLUTION_NOTE}

${metadataNote}TOPICS:
${topicList}

Respond with ONLY a JSON object of this exact shape:
{"topics": [{"unitOrder": number, "topicOrder": number, "status": "ready" | "needs_teacher_input", "teacherHint": string | null, "objectives": string[], "lessons": [{"title": string, "summary": string}]}]}

Every unitOrder/topicOrder pair in your response MUST exactly match one from the list above. Do not add topics that are not listed.`;

  if (!previousErrors) return base;
  return `${base}\n\nYour previous response was invalid: ${previousErrors.join('; ')}. Respond again with ONLY the corrected JSON object.`;
}

// Thin wrapper kept for callers/tests that import callGroq by name — the
// actual provider fallback chain lives in services/llm/fallback.js.
async function callGroq(prompt) {
  const content = await callWithFallback(prompt, { json: true, temperature: 0.3 });
  return { choices: [{ message: { content } }] };
}

const NO_LESSON_HINT = 'No lesson could be written for this topic just now (the AI service was busy). Use "Generate lesson again", or add the lesson yourself in Edit.';

function validateGeneratedTopics(parsed, topicRefs) {
  if (!parsed || !Array.isArray(parsed.topics)) {
    return { valid: false, errors: ['response.topics must be an array'] };
  }

  const validKeys = new Set(topicRefs.map((r) => `${r.unitOrder}:${r.topicOrder}`));
  const errors = [];
  const topics = [];

  parsed.topics.forEach((entry, i) => {
    if (typeof entry?.unitOrder !== 'number' || typeof entry?.topicOrder !== 'number') {
      errors.push(`topics[${i}] missing numeric unitOrder/topicOrder`);
      return;
    }
    const key = `${entry.unitOrder}:${entry.topicOrder}`;
    if (!validKeys.has(key)) {
      errors.push(`topics[${i}] references unknown topic ${key} — dropped`);
      return;
    }
    const objectives = Array.isArray(entry.objectives)
      ? entry.objectives.filter((o) => typeof o === 'string' && o.trim()).map((o) => o.trim())
      : [];
    const lessons = Array.isArray(entry.lessons)
      ? entry.lessons
          .filter((l) => l && typeof l.title === 'string' && l.title.trim())
          .map((l) => ({ title: l.title.trim(), summary: typeof l.summary === 'string' ? l.summary.trim() : '' }))
      : [];
    // Model omitting status/teacherHint (older prompt behavior, or a lenient
    // model) defaults to "ready"/null rather than failing validation — the
    // gap-resolution protocol is a quality signal, not a required field.
    // This last-resort path writes objectives only, never a lesson: the topic always needs the teacher before
    // students see it (it used to be marked ready and could be published empty).
    const status = 'needs_teacher_input';
    const teacherHint = typeof entry.teacherHint === 'string' && entry.teacherHint.trim()
      ? entry.teacherHint.trim()
      : NO_LESSON_HINT;
    topics.push({ unitOrder: entry.unitOrder, topicOrder: entry.topicOrder, objectives, lessons, status, teacherHint, groundingSource: 'upload_text_only' });
  });

  if (topics.length === 0) {
    return { valid: false, errors: errors.length ? errors : ['response contained no usable topics'] };
  }
  return { valid: true, errors, topics };
}

function mergeGeneratedContent(normalized, generatedTopics) {
  const byKey = new Map(generatedTopics.map((t) => [`${t.unitOrder}:${t.topicOrder}`, t]));
  return {
    version: 1,
    metadata: normalized.metadata || {},
    units: normalized.units.map((unit) => ({
      title: unit.title,
      order: unit.order,
      topics: unit.topics.map((topic) => {
        const generated = byKey.get(`${unit.order}:${topic.order}`);
        return {
          title: topic.title,
          order: topic.order,
          subtopics: topic.subtopics.map((s) => ({ title: s.title, order: s.order })),
          objectives: generated?.objectives || [],
          lessons: generated?.lessons || [],
          status: generated ? (generated.status || 'ready') : 'needs_teacher_input',
          teacherHint: generated ? (generated.teacherHint ?? null) : NO_LESSON_HINT,
          content: generated?.content || null,
          groundingSource: generated?.groundingSource || 'none',
          quality: generated?.quality || null,
        };
      }),
    })),
  };
}

async function attemptGeneration(prompt, topicRefs) {
  let completion;
  try {
    completion = await callGroq(prompt);
  } catch (err) {
    return { ok: false, errors: [`Groq generation failed: ${err.message}`] };
  }

  const raw = completion.choices?.[0]?.message?.content || '';
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    return { ok: false, errors: ['AI returned invalid JSON'] };
  }

  const result = validateGeneratedTopics(parsed, topicRefs);
  return result.valid ? { ok: true, topics: result.topics } : { ok: false, errors: result.errors };
}

// Attaches listenParts/practiceQuiz to each topic's content in place. A
// companion failure never fails the topic — the topic just keeps content
// without these fields (generateCompanions already returns null on failure).
async function attachCompanions(topics, topicRefs, metadata) {
  const refByKey = new Map(topicRefs.map((r) => [`${r.unitOrder}:${r.topicOrder}`, r]));
  await mapWithConcurrency(topics, DRAFT_CONCURRENCY, async (t) => {
    if (!t.content) return;
    const ref = refByKey.get(`${t.unitOrder}:${t.topicOrder}`);
    if (!ref) return;
    // One retry: a single failed call used to leave a topic with no Listen and no Practice at all.
    const companions = (await generateCompanions(ref, metadata, t.content).catch(() => null))
      || (await generateCompanions(ref, metadata, t.content).catch(() => null));
    if (companions) {
      t.content.listenParts = companions.listenParts;
      t.content.practiceQuiz = companions.practiceQuiz;
    }
  });
}

// Grade-fit pass: rules + Groq judge per topic (checkGradeFit). On failure,
// ONE regeneration (content via groundTopic/knowledgeTopic + companions)
// with issues fed back as qualityFeedback; still-failing topics get
// needs_teacher_input. Bounded per topic: 1 judge call + (on failure) the
// regen's own bounded content calls + 1 companions call + 1 re-judge call.
async function applyGradeFit(topics, topicRefs, metadata) {
  const refByKey = new Map(topicRefs.map((r) => [`${r.unitOrder}:${r.topicOrder}`, r]));
  await mapWithConcurrency(topics, DRAFT_CONCURRENCY, async (t) => {
    if (!t.content || !['ncert_vector', 'model_knowledge', 'reference_sources'].includes(t.groundingSource)) return;
    const ref = refByKey.get(`${t.unitOrder}:${t.topicOrder}`);
    if (!ref) return;
    const chapterTitle = resolveChapterTitle(ref, metadata);
    const gradeFitArgs = (content) => ({ topicTitle: ref.topicTitle, chapterTitle, grade: metadata?.grade, subject: metadata?.subject, subtopics: ref.subtopics, content });

    let result = await checkGradeFit(gradeFitArgs(t.content)).catch(() => null);
    if (!result) return;

    if (result.failed) {
      const feedback = result.quality.issues.join('; ');
      const regenTopic = t.groundingSource !== 'model_knowledge'
        ? await groundTopic(ref, metadata, feedback).catch(() => null)
        : await knowledgeTopic(ref, metadata, feedback).catch(() => null);
      if (regenTopic?.content) {
        const companions = await generateCompanions(ref, metadata, regenTopic.content).catch(() => null);
        if (companions) {
          regenTopic.content.listenParts = companions.listenParts;
          regenTopic.content.practiceQuiz = companions.practiceQuiz;
        }
        t.content = regenTopic.content;
        result = await checkGradeFit(gradeFitArgs(t.content)).catch(() => result);
      }
    }

    t.quality = result.quality;
    if (result.failed) {
      t.status = 'needs_teacher_input';
      t.teacherHint = `Grade-fit review: ${result.quality.issues.slice(0, 5).join('; ')}`;
    }
  });
}

// Cache key per unitOrder:topicOrder — unit title is deliberately excluded
// (see topicCache.buildCacheKey) so the same topic under a different unit
// name still hits the shared cache.
function keyFor(refsByPos, pos) {
  return refsByPos.get(pos);
}

async function generateLearningPathDraft(normalized, onTopicDone) {
  let topicRefs = collectTopicRefs(normalized);
  if (topicRefs.length === 0) {
    return mergeGeneratedContent(normalized, []);
  }

  const allRefs = topicRefs;
  let doneCount = 0;
  const tick = (n = 1) => { for (let i = 0; i < n; i++) { doneCount++; if (onTopicDone) Promise.resolve(onTopicDone(doneCount, allRefs.length)).catch(() => {}); } };

  // Book first: topics matched to real book sections are assembled from pre-built content. Only topics with no
  // book match at all go through the AI generation pipeline below.
  const bookMatches = await matchTopicsToBook(allRefs, normalized.metadata).catch(() => new Map());
  allRefs.forEach((ref, i) => {
    ref.bookMatch = bookMatches.get(i) || null;
    ref.bookSections = sectionsForTopic(ref.bookMatch);
  });
  const bookRefs = usesNcertBooks(normalized.metadata) ? allRefs.filter((r) => r.bookSections.length) : [];
  const fromBook = (await mapWithConcurrency(bookRefs, DRAFT_CONCURRENCY, async (ref) => {
    const topic = await bookTopic(ref, normalized.metadata).catch((err) => {
      console.error(`[aiGeneration] book topic failed for "${ref.topicTitle}":`, err.message);
      return null;
    });
    if (topic) tick();
    return topic;
  })).filter(Boolean);
  const bookKeys = new Set(fromBook.map((t) => `${t.unitOrder}:${t.topicOrder}`));
  topicRefs = allRefs.filter((ref) => !bookKeys.has(`${ref.unitOrder}:${ref.topicOrder}`));
  if (topicRefs.length === 0) return mergeGeneratedContent(normalized, fromBook);

  const cacheKeys = new Map(topicRefs.map((ref) => [`${ref.unitOrder}:${ref.topicOrder}`, buildCacheKey(normalized.metadata, ref)]));

  // Shared cache pass: any topic another teacher already generated (same
  // curriculum/grade/subject/topic/subtopics/pipeline version) is served
  // straight from cache — no LLM call at all for it.
  const cacheHits = await mapWithConcurrency(topicRefs, DRAFT_CONCURRENCY, async (ref) => {
    const cached = await getCachedTopic(keyFor(cacheKeys, `${ref.unitOrder}:${ref.topicOrder}`)).catch(() => null);
    if (!cached) return null;
    tick();
    return { unitOrder: ref.unitOrder, topicOrder: ref.topicOrder, ...cached, fromCache: true };
  });
  const cached = cacheHits.filter(Boolean);
  const cachedKeys = new Set(cached.map((c) => `${c.unitOrder}:${c.topicOrder}`));
  const uncachedRefs = topicRefs.filter((ref) => !cachedKeys.has(`${ref.unitOrder}:${ref.topicOrder}`));

  if (uncachedRefs.length === 0) {
    return mergeGeneratedContent(normalized, [...fromBook, ...cached]);
  }

  // Prefer real NCERT/vector grounding per topic. Topics where retrieval is
  // genuinely insufficient fall through to the upload-text-grounded batch
  // path below — never silently upgraded to invented "generic knowledge".
  // dedupeGeneration collapses identical topics generating concurrently
  // (this draft or another in-flight upload in the same process).
  const groundedResults = await mapWithConcurrency(uncachedRefs, DRAFT_CONCURRENCY, (ref) =>
    dedupeGeneration(`ground:${keyFor(cacheKeys, `${ref.unitOrder}:${ref.topicOrder}`)}`, () => groundTopic(ref, normalized.metadata))
  );
  const grounded = groundedResults.filter(Boolean);
  await attachCompanions(grounded, uncachedRefs, normalized.metadata);
  await applyGradeFit(grounded, uncachedRefs, normalized.metadata);
  await cacheReadyTopics(grounded, uncachedRefs, cacheKeys, normalized.metadata);
  tick(grounded.length);
  const groundedKeys = new Set(grounded.map((g) => `${g.unitOrder}:${g.topicOrder}`));
  const ungroundedRefs = uncachedRefs.filter((ref) => !groundedKeys.has(`${ref.unitOrder}:${ref.topicOrder}`));

  if (ungroundedRefs.length === 0) {
    return mergeGeneratedContent(normalized, [...fromBook, ...cached, ...grounded]);
  }

  // Try the model's own knowledge per topic before falling back to the
  // objectives-only batch path. Only unknown/failed topics fall through.
  const knowledgeResults = await mapWithConcurrency(ungroundedRefs, DRAFT_CONCURRENCY, (ref) =>
    dedupeGeneration(`knowledge:${keyFor(cacheKeys, `${ref.unitOrder}:${ref.topicOrder}`)}`, () => knowledgeTopic(ref, normalized.metadata))
  );
  const knowledge = knowledgeResults.filter(Boolean);
  await attachCompanions(knowledge, ungroundedRefs, normalized.metadata);
  await applyGradeFit(knowledge, ungroundedRefs, normalized.metadata);
  await cacheReadyTopics(knowledge, ungroundedRefs, cacheKeys, normalized.metadata);
  tick(knowledge.length);
  const knowledgeKeys = new Set(knowledge.map((k) => `${k.unitOrder}:${k.topicOrder}`));
  const remainingRefs = ungroundedRefs.filter((ref) => !knowledgeKeys.has(`${ref.unitOrder}:${ref.topicOrder}`));

  if (remainingRefs.length === 0) {
    return mergeGeneratedContent(normalized, [...fromBook, ...cached, ...grounded, ...knowledge]);
  }

  const first = await attemptGeneration(buildPrompt(remainingRefs, normalized.metadata), remainingRefs);
  if (first.ok) tick(first.topics.length);
  if (first.ok) return mergeGeneratedContent(normalized, [...fromBook, ...cached, ...grounded, ...knowledge, ...first.topics]);

  const second = await attemptGeneration(buildPrompt(remainingRefs, normalized.metadata, first.errors), remainingRefs);
  if (second.ok) tick(second.topics.length);
  if (second.ok) return mergeGeneratedContent(normalized, [...fromBook, ...cached, ...grounded, ...knowledge, ...second.topics]);

  if (fromBook.length > 0 || cached.length > 0 || grounded.length > 0 || knowledge.length > 0) return mergeGeneratedContent(normalized, [...fromBook, ...cached, ...grounded, ...knowledge]);
  throw new LearningPathGenerationError(`AI generation failed after retry: ${second.errors.join('; ')}`);
}

// Write-back: only topics that finished 'ready' (post companions+gradeFit)
// are cacheable — a needs_teacher_input/failed topic must regenerate for
// every teacher, it was never real content. Errors are swallowed inside
// persistCachedTopic itself so a cache outage never fails generation.
async function cacheReadyTopics(topics, refs, cacheKeys, metadata) {
  const refByKey = new Map(refs.map((r) => [`${r.unitOrder}:${r.topicOrder}`, r]));
  await Promise.all(
    topics.map((t) => {
      const posKey = `${t.unitOrder}:${t.topicOrder}`;
      const ref = refByKey.get(posKey);
      if (!ref) return null;
      const { unitOrder, topicOrder, fromCache, ...payload } = t;
      return persistCachedTopic(cacheKeys.get(posKey), {
        curriculum: metadata?.curriculum, grade: metadata?.grade, subject: metadata?.subject, topic: ref.topicTitle, payload,
      });
    })
  );
}

// Regenerates one topic with the book sections the teacher picked per subtopic
// (chosen[j] = {pdfFile, title} or null = not in the book). Returns the draft topic fields to replace.
async function rebuildTopic(normalized, unitOrder, topicOrder, chosen) {
  const ref = collectTopicRefs(normalized).find((r) => r.unitOrder === unitOrder && r.topicOrder === topicOrder);
  if (!ref) throw new LearningPathGenerationError(`Topic ${unitOrder}:${topicOrder} not found`);
  const metadata = normalized.metadata;
  const sections = await loadBookSections(metadata?.grade, metadata?.subject);
  const find = (c) => sections.find((s) => s.pdfFile === c?.pdfFile && s.title === c?.title) || null;
  ref.bookMatch = {
    subtopics: matchUnits(ref).map((title, j) => {
      const picked = [].concat(chosen?.[j] ?? []).map(find).filter(Boolean);
      return { title, section: picked[0] || null, sections: picked };
    }),
  };
  ref.bookSections = sectionsForTopic(ref.bookMatch);

  let topic;
  if (ref.bookSections.length && usesNcertBooks(metadata)) {
    topic = await bookTopic(ref, metadata);
  } else {
    topic = (await groundTopic(ref, metadata).catch(() => null)) || (await knowledgeTopic(ref, metadata).catch(() => null));
    if (topic) {
      await attachCompanions([topic], [ref], metadata);
      await applyGradeFit([topic], [ref], metadata);
    }
  }
  if (!topic) throw new LearningPathGenerationError('Could not rebuild this topic right now — please try again');
  const { unitOrder: _u, topicOrder: _t, ...fields } = topic;
  return { ...fields, quality: topic.quality || null };
}

module.exports = {
  generateLearningPathDraft,
  rebuildTopic,
  collectTopicRefs,
  validateGeneratedTopics,
  mergeGeneratedContent,
  deriveObjectivesAndLessons,
  generateWorkedExample,
  knowledgeTopic,
  generateCompanions,
  applyGradeFit,
  matchChapter,
  LearningPathGenerationError,
};
