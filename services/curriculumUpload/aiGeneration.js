const Groq = require('groq-sdk');
const { retrieveGroundingContext } = require('./groundedContent');
const { validateBlock } = require('../curriculum/blockSchema');

let _groq = null;
function getGroqClient() {
  if (!_groq) _groq = new Groq({ apiKey: process.env.GROQ_API_KEY });
  return _groq;
}

// Lazy — enrichment.js constructs its own Groq/Supabase clients at module
// load, which crashes under jest.requireActual in tests that only need this
// file's error classes. Requiring it on first real use avoids that entirely.
let _enrichment = null;
function getEnrichment() {
  if (!_enrichment) _enrichment = require('../curriculum/enrichment');
  return _enrichment;
}

// Same models already proven for structured JSON generation in this service
// (services/curriculum/enrichment.js) — primary 120b, falling back to the
// 20b model on failure/rate-limit.
const PRIMARY_MODEL = 'openai/gpt-oss-120b';
const FALLBACK_MODEL = 'openai/gpt-oss-20b';

class LearningPathGenerationError extends Error {}

const MAX_SOURCE_CONTEXT_CHARS = 1500;

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
        summary: `${block.problem} ${block.steps.map((s) => s.action).join(' ')} Final answer: ${block.finalAnswer}`,
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
// topics still need a real example, so this makes ONE additional targeted
// Groq call — reusing the same client/model-fallback path, not a new
// pipeline — asking specifically for a worked_example grounded in the
// retrieved context's named method/key-terms. Numbers are necessarily
// invented (the source has none), but arithmetic correctness is required.
// Failure here never fails the topic — it just means no worked example.
async function generateWorkedExample(topicRef, metadata, retrievedContext) {
  const prompt = `You are creating ONE worked mathematical example for a student learning "${topicRef.topicTitle}"${metadata?.grade ? ` (Grade ${metadata.grade})` : ''}.

SOURCE MATERIAL (use its named method/technique — do not use a different method):
"${retrievedContext}"

Write one concrete numeric problem that applies the method described above, and solve it step by step with fully correct arithmetic (double-check every calculation before answering).

Respond with ONLY a JSON object of this exact shape:
{"type":"worked_example","problem":"...","concept":"...","steps":[{"step":1,"action":"...","equation":"...","why":"..."}],"finalAnswer":"...","check":"..."}`;

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

  return validateBlock(block) ? block : null;
}

async function groundTopic(topicRef, metadata) {
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
  });
  if (!generated.ok) return null;

  if (contentType === 'mathematics' && !generated.blocks.some((b) => b.type === 'worked_example')) {
    const workedExample = await generateWorkedExample(topicRef, metadata, retrieved.context);
    if (workedExample) generated.blocks = [...generated.blocks, workedExample];
  }

  const { objectives, lessons } = deriveObjectivesAndLessons(generated.whatYoullLearn, generated.blocks);
  return {
    unitOrder: topicRef.unitOrder,
    topicOrder: topicRef.topicOrder,
    objectives,
    lessons,
    // A grounded topic has real retrieved content by construction, so it's
    // always "ready" — needs_teacher_input only ever applies to the
    // upload-text-only fallback path below, which has no vector grounding
    // to fall back on.
    status: 'ready',
    teacherHint: null,
    content: { whatYoullLearn: generated.whatYoullLearn, blocks: generated.blocks, contentType },
    groundingSource: 'ncert_vector',
  };
}

// Grade-band calibration for the batch (ungrounded-fallback) prompt path —
// the grounded path already gets its calibration for free via enrichment.js's
// own contentType-driven generation, but this path writes objectives/lessons
// straight from a template, so vocabulary/pacing has to be steered explicitly.
function gradeCalibrationNote(grade) {
  const g = Number(String(grade || '').match(/(\d+)/)?.[1]);
  if (!g) return '';
  if (g <= 2) {
    return 'GRADE CALIBRATION: Early years. Use basic phonics-level vocabulary, sentences under 12 words, and concrete physical analogies (counting objects, animals, toys). Keep each lesson bite-sized.';
  }
  if (g <= 5) {
    return 'GRADE CALIBRATION: Elementary. Use accessible vocabulary with inline explanations of any new term, sequential numbered steps, and visual anchors a child can picture.';
  }
  if (g <= 8) {
    return 'GRADE CALIBRATION: Middle school. Use domain-specific terminology with structured definitions, multi-step reasoning, and real-world context.';
  }
  return 'GRADE CALIBRATION: High school. Use advanced technical/academic prose, abstract models, and formal multi-step problem-solving where relevant.';
}

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

async function callGroq(prompt) {
  const opts = {
    messages: [{ role: 'user', content: prompt }],
    response_format: { type: 'json_object' },
    temperature: 0.3,
  };
  const groq = getGroqClient();
  try {
    return await groq.chat.completions.create({ model: PRIMARY_MODEL, ...opts });
  } catch (primaryErr) {
    return await groq.chat.completions.create({ model: FALLBACK_MODEL, ...opts });
  }
}

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
    const status = entry.status === 'needs_teacher_input' ? 'needs_teacher_input' : 'ready';
    const teacherHint = status === 'needs_teacher_input' && typeof entry.teacherHint === 'string' && entry.teacherHint.trim()
      ? entry.teacherHint.trim()
      : null;
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
          status: generated?.status || 'ready',
          teacherHint: generated?.teacherHint ?? null,
          content: generated?.content || null,
          groundingSource: generated?.groundingSource || 'none',
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

async function generateLearningPathDraft(normalized) {
  const topicRefs = collectTopicRefs(normalized);
  if (topicRefs.length === 0) {
    return mergeGeneratedContent(normalized, []);
  }

  // Prefer real NCERT/vector grounding per topic. Topics where retrieval is
  // genuinely insufficient fall through to the upload-text-grounded batch
  // path below — never silently upgraded to invented "generic knowledge".
  const groundedResults = await Promise.all(topicRefs.map((ref) => groundTopic(ref, normalized.metadata)));
  const grounded = groundedResults.filter(Boolean);
  const groundedKeys = new Set(grounded.map((g) => `${g.unitOrder}:${g.topicOrder}`));
  const ungroundedRefs = topicRefs.filter((ref) => !groundedKeys.has(`${ref.unitOrder}:${ref.topicOrder}`));

  if (ungroundedRefs.length === 0) {
    return mergeGeneratedContent(normalized, grounded);
  }

  const first = await attemptGeneration(buildPrompt(ungroundedRefs, normalized.metadata), ungroundedRefs);
  if (first.ok) return mergeGeneratedContent(normalized, [...grounded, ...first.topics]);

  const second = await attemptGeneration(buildPrompt(ungroundedRefs, normalized.metadata, first.errors), ungroundedRefs);
  if (second.ok) return mergeGeneratedContent(normalized, [...grounded, ...second.topics]);

  if (grounded.length > 0) return mergeGeneratedContent(normalized, grounded);
  throw new LearningPathGenerationError(`AI generation failed after retry: ${second.errors.join('; ')}`);
}

module.exports = {
  generateLearningPathDraft,
  collectTopicRefs,
  validateGeneratedTopics,
  mergeGeneratedContent,
  deriveObjectivesAndLessons,
  generateWorkedExample,
  LearningPathGenerationError,
};
