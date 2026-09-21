const Groq = require('groq-sdk');
const { retrieveGroundingContext } = require('./groundedContent');
const { validateBlock } = require('../curriculum/blockSchema');
const { gradeCalibrationNote } = require('../curriculum/gradeCalibration');
const { verifyWorkedExample } = require('./mathValidator');

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

  // Any worked_example enrichment.js already produced came straight from the
  // retrieved NCERT text (it deliberately omits the block otherwise — see
  // enrichment.js's COMMON_RULES rule 7) — tag it SOURCE_DERIVED, the
  // taxonomy's real-example category, distinct from the invented-but-verified
  // GROUNDED_SYNTHETIC one generateWorkedExample() below produces.
  generated.blocks = generated.blocks.map((b) =>
    b.type === 'worked_example' && !b.exampleType ? { ...b, exampleType: 'SOURCE_DERIVED' } : b
  );

  // Attach the top retrieved image (if any) as a real "image" block — the
  // url/caption come straight from Qdrant via rag.js's buildImages(), never
  // invented by the LLM prompt.
  const topImage = (retrieved.images || [])[0];
  if (topImage?.url) {
    generated.blocks = [...generated.blocks, { type: 'image', url: topImage.url, caption: topImage.caption || topicRef.topicTitle, alt_text: topImage.caption || topicRef.topicTitle }];
  }

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
