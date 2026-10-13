// AI enrichment pilot for the Learn tab's LEFT-SIDE simplified content
// (Qdrant-only topics — see resourceResolver.js's resolveResourcesByTopicName
// and qdrant.js's resolveTopicWithContext for how "primary" vs "context"
// source chunks are separated).
//
// Flow: Qdrant (primary + context chunks) -> LLM -> validated structured
// JSON -> persisted in topic_ai_enrichment (Supabase) -> served. A second
// request for the same (curriculum, grade, subject, topic) is served from
// that table with NO further LLM call — see getOrGenerateEnrichment().
//
// Reuses the same inline groq-sdk pattern already used elsewhere in this
// codebase (aivorah-learning-paths-service/routes/ibpyp.js,
// aivorah-assignments-service/routes/assignments.js) — there is no shared
// LLM-provider abstraction in this stack to plug into instead.
const supabase = require('../supabase');
const { normalizeCurriculum } = require('../curriculumName');
const { validateEnrichment } = require('./blockSchema');
const { gradeCalibrationNote } = require('./gradeCalibration');
const { callWithFallback } = require('../llm/fallback');

const SCHEMA_VERSION = 1;
const PROMPT_VERSION = 'v1';
// Kept only as the persisted "model" label — the actual model used per call
// is whichever LLM_CHAIN entry succeeded (see services/llm/fallback.js).
const PRIMARY_MODEL = 'openai/gpt-oss-120b';

// Subject -> content-type classification. Drives which block types the
// prompt asks for. Deliberately name-based (not hard-coded per-subject
// rendering logic in the frontend — the frontend only switches on block
// `type`, never on subject) so a new subject just needs one line here.
function classifyContentType(subject) {
  const s = String(subject || '').trim().toLowerCase();
  if (s === 'mathematics' || s === 'maths') return 'mathematics';
  if (s === 'physics') return 'physics';
  if (s === 'chemistry') return 'chemistry';
  if (s === 'biology' || s === 'science') return 'biology';
  if (['english', 'hindi', 'sanskrit', 'french', 'german', 'spanish'].includes(s)) return 'language';
  return 'theory'; // commerce/social-science/humanities default
}

// Exact field shapes, one line of real JSON per type — a prose description
// alone ("include a text field") was not enough; an earlier version of this
// prompt without literal shapes produced plausible-but-wrong field names
// (e.g. "content" instead of "text", flat string arrays instead of
// {term, definition} objects) that failed schema validation on every block.
const BLOCK_SHAPES = `{"type":"overview","text":"..."}
{"type":"explanation","text":"..."}
{"type":"key_terms","items":[{"term":"...","definition":"..."}]}
{"type":"key_points","items":["...","..."]}
{"type":"example","text":"..."}
{"type":"formula","name":"...","expression":"...","variables":[{"symbol":"...","meaning":"...","unit":"..."}]}
{"type":"worked_example","problem":"...","concept":"...","steps":[{"step":1,"action":"...","equation":"...","why":"..."}],"finalAnswer":"...","check":"..."}
{"type":"chemical_equation","equation":"...","explanation":"..."}
{"type":"process","title":"...","steps":["...","..."]}
{"type":"comparison","title":"...","items":[{"name":"...","description":"..."}]}
{"type":"poem_line","sourceText":"...","explanation":"..."}
{"type":"prose_excerpt","sourceText":"...","explanation":"..."}
{"type":"vocabulary","items":[{"term":"...","meaning":"..."}]}
{"type":"activity","text":"..."}
{"type":"tip","text":"..."}
{"type":"common_mistake","text":"..."}
{"type":"timeline","title":"...","events":[{"date":"...","description":"..."}]}
{"type":"cause_and_effect","title":"...","items":[{"cause":"...","effect":"..."}]}
{"type":"case_study","title":"...","text":"..."}
{"type":"table","caption":"...","headers":["...","..."],"rows":[["...","..."],["...","..."]]}
Use these EXACT field names for whichever types you use — do not rename "text" to "content", do not flatten {term, definition} items into a plain string array, do not omit "type".`;

const CONTENT_TYPE_GUIDANCE = {
  theory: `Use these block types as appropriate: overview, explanation, key_terms, key_points, example, activity, tip.
If the SOURCE TEXT is History/Civics/Geography content, also use these when the source actually supports them: "timeline" for a sequence of dated events, "cause_and_effect" for causal relationships the source describes, "case_study" for a specific real example/scenario the source discusses in depth.
Do not force every block type — only include a block if the source material actually supports it.`,
  mathematics: `Use these block types as appropriate: overview, explanation, key_terms, formula, worked_example, key_points, activity, common_mistake, table.
If the source contains a worked problem/example sum, you MUST produce a "worked_example" block — never just state the final answer. "steps" needs one entry per real step, and "why" must explain the reasoning, not just restate the arithmetic.
Write equations/expressions as LaTeX-compatible strings (e.g. "x^2 + 3x - 4 = 0", "\\\\frac{a}{b}") — never flatten them into ambiguous plain text. Numerical formulas, expansions, and coordinate/value breakdowns should be expressed as clean Markdown tables ("table" block), callouts, or LaTeX ($inline$ / $$display$$), not requested or described as raster images.
If no grounded image is available for a place-value/quantitative topic, produce a "table" block representing the relevant structure (e.g. a Place Value Chart: headers for Periods/Places such as ["Period","Digit"] or ["TTh","Th","H","T","O"], rows with example values) instead of describing an image you cannot generate.`,
  physics: `Use these block types as appropriate: overview, explanation, key_terms, formula, worked_example, key_points, tip.
"formula" blocks should include the variables and their units where the source states them. Numerical worked examples follow the same worked_example shape as mathematics, and the final answer must include units.`,
  chemistry: `Use these block types as appropriate: overview, explanation, key_terms, chemical_equation, key_points, example, tip.
"chemical_equation" blocks must use the exact reactants/products/notation from the source — do not invent a reaction not present in the source text.`,
  biology: `Use these block types as appropriate: overview, explanation, key_terms, process, comparison, key_points, activity.
Use "process" for any sequence/stages the source describes (e.g. a biological cycle), and "comparison" only when the source is actually contrasting two or more things.`,
  language: `Use these block types as appropriate: overview, explanation, poem_line, prose_excerpt, vocabulary, key_points.
CRITICAL: if the source contains an actual line of poetry, dialogue, or prose excerpt, you MUST put the EXACT original text (verbatim, same language/script) in a "poem_line" or "prose_excerpt" block's "sourceText" field, and your simplified explanation of it in that same block's "explanation" field — NEVER rewrite the original and present the rewrite as if it were the source. If the source is in Hindi or another Indian language, keep sourceText in that language's script and write "explanation" in simple language a student of that language would understand (do not switch to English for the explanation of a language-subject text).`,
};

const COMMON_RULES = `You are producing a strictly source-grounded, student-friendly explanation of ONE textbook topic for a school student.

Rules — follow all of them:
1. Only use facts, terms, numbers, formulas, quotations, and examples that are actually present in the SOURCE TEXT below. Never invent a fact, formula, example, or quotation and imply it came from the textbook.
2. The CONTEXT TEXT (if present) is neighboring textbook material for background/flow only — do not use it to introduce claims about THIS topic that aren't in the SOURCE TEXT; it exists only to help you write a coherent explanation, not as additional source-of-truth content for this specific topic.
3. Explain AT the student's grade level — actually explain difficult ideas simply, don't just shorten sentences.
4. Produce ONLY valid JSON matching this exact top-level shape (no markdown fences, no commentary):
{"whatYoullLearn": ["...", "..."], "blocks": [ {"type": "...", ...fields...}, ... ]}
5. "whatYoullLearn" is a short list (2-4 items) of what the student will understand after this topic, grounded in the source.
6. Every block must have a "type" field from the allowed list below, plus that type's required fields.
7. If there genuinely isn't enough source material to support a block type (e.g. no worked example present), do not fabricate one just to fill a slot — omit it.
8. Never produce an empty blocks array — if the source is thin, still produce at least an "explanation" block grounded in exactly what's there.
9. DUAL/COMPOSITE CONCEPTS: if the topic title names more than one distinct concept (e.g. "Place Value and Face Value", "Successor and Predecessor"), you MUST explicitly define, contrast, and give a worked example for EVERY named concept — never substitute or over-index on an adjacent idea (e.g. comma placement, large-number reading) instead of covering all the concepts actually named in the title. Address each named concept by name.
10. INDIAN PLACE VALUE SYSTEM: whenever this content involves comma placement, periods, or reading/writing large numbers, use the Indian Place Value System (commas after the first 3 digits from the right, then every 2 digits — e.g. 9,63,001; periods: Ones, Thousands, Lakhs, Crores) as the primary and correct convention, since NCERT uses this system. Only mention the International system (commas every 3 digits, e.g. 963,001) as a labeled contrast if pedagogically relevant — never present both as equally valid without clearly labeling which one is NCERT-standard.`;

// Fixed Grade-6-style lesson recipe, applied to both generation paths.
// checkRecipe() verifies it programmatically so a missing part triggers one
// regeneration rather than silently shipping a thin lesson.
const RECIPE_RULES = `LESSON RECIPE — the blocks array must cover all of these:
- An "overview" block whose text is a hook QUESTION (ends with "?") that pulls the student in.
- One or more short "explanation" blocks (keep each chunk short, not one wall of text).
- At least one "example" block grounded in a real-life INDIAN context (Indian names, places, currency, everyday scenes).
- At least one visual block: "image", "table", "process", "comparison", "timeline", or "cause_and_effect".
- An "activity" block.
- A "common_mistake" block.
- A "key_terms" block.
- A QUICK CHECK: one extra "key_points" block (separate from any other key_points block) with EXACTLY 2 items, each a short question ending in "?", for the student to self-check understanding.
NEVER write meta/instructional text about the content itself — no phrases like "a fraction that appears in a real-life Indian context", "The chapter tells us...", "In the [chapter] chapter, the sub-topic [topic] introduces...". Write the actual explanation/example directly, as if speaking to the student, never describing what you were asked to produce.`;

function checkRecipe(blocks) {
  const list = Array.isArray(blocks) ? blocks : [];
  const missing = [];
  const overview = list.find((b) => b.type === 'overview');
  if (!overview || !/\?\s*$/.test(String(overview.text || '').trim())) missing.push('hook question (overview block ending in "?")');
  if (!list.some((b) => b.type === 'explanation')) missing.push('explanation block(s)');
  if (!list.some((b) => b.type === 'example')) missing.push('a real-life Indian example block');
  if (!list.some((b) => ['image', 'table', 'process', 'comparison', 'timeline', 'cause_and_effect'].includes(b.type))) missing.push('a visual block (image/table/process/comparison/timeline/cause_and_effect)');
  if (!list.some((b) => b.type === 'activity')) missing.push('an activity block');
  if (!list.some((b) => b.type === 'common_mistake')) missing.push('a common_mistake block');
  if (!list.some((b) => b.type === 'key_terms')) missing.push('a key_terms block');
  const hasQuickCheck = list.some(
    (b) => b.type === 'key_points' && Array.isArray(b.items) && b.items.filter((i) => /\?\s*$/.test(String(i || '').trim())).length >= 2
  );
  if (!hasQuickCheck) missing.push('a 2-question quick check (key_points block with 2 question items)');
  return missing;
}

// Grade-fit regen: appends the reviewer's issues so a re-prompt can fix them.
// Curricula without their own books here (IB, ...) draw on other curricula's material: never name it.
function neutralSourceNote(input) {
  if (!input.neutralSource) return '';
  return `\nThis lesson is for a ${input.curriculum || ''} class. The source may come from another curriculum's textbook: NEVER mention any textbook, book series, chapter, page or figure number, or another curriculum. Rewrite references like "Fig. 2.3" or "in this chapter" so the lesson stands on its own.\n`;
}

// Curricula without their own books here: the teacher's syllabus decides what is taught, not whatever the reference
// material happens to cover.
function mustCoverNote(input) {
  const subs = (input.mustCover || []).filter(Boolean);
  if (!subs.length) return '';
  return `\nTHE TEACHER'S SYLLABUS FOR THIS TOPIC: ${subs.map((s) => `"${s}"`).join(', ')}.
Teach EVERY one of these, each with its own short explanation and an example. Use the SOURCE TEXT where it covers a subtopic; for a subtopic it does not cover, teach it from standard, well-established Grade ${input.grade} knowledge (rule 1 is relaxed only for these). Ignore any part of the source that is about a different topic.
Write for a Grade ${input.grade} student: short sentences (mostly under 15 words), everyday words, one idea at a time. Each explanation block is 2-4 such sentences.\n`;
}

function qualityFeedbackNote(input) {
  return input.qualityFeedback ? `\n\nQUALITY REVIEW FEEDBACK — fix these issues in your response: ${input.qualityFeedback}\n` : '';
}

function buildKnowledgePrompt(input) {
  const { curriculum, grade, subject, chapterTitle, chapterMatched, unitTitle, topic, subtopics, contentType } = input;
  const guidance = CONTENT_TYPE_GUIDANCE[contentType] || CONTENT_TYPE_GUIDANCE.theory;
  const calibrationNote = gradeCalibrationNote(grade);
  const subtopicsLine = Array.isArray(subtopics) && subtopics.length ? `\nSubtopics to cover: ${subtopics.join('; ')}.` : '';

  // Two anchoring modes: a CONFIRMED registry chapter match keeps the
  // stricter "stay within this chapter" wording (chapter-anchored); anything
  // else (no match, or only a raw unit title from the upload) teaches the
  // topic directly like ChatGPT would — the topic not being in OUR current
  // textbook is not a reason to refuse, only a genuinely unintelligible/
  // not-a-real-school-topic title is.
  const anchor = chapterMatched
    ? `Write from your own knowledge of the ${curriculum} Grade ${grade} ${subject} chapter "${chapterTitle}", topic "${topic}". Stay strictly within that chapter's syllabus — do not bring in content from other chapters or grades.${subtopicsLine}

If you are not confident that "${topic}" genuinely belongs to the chapter "${chapterTitle}", respond with ONLY {"unknown":true} and nothing else.`
    : `Teach this topic as appropriate for ${curriculum} Grade ${grade} ${subject}${unitTitle ? `, unit "${unitTitle}"` : ''}, topic "${topic}", from your own general knowledge of the subject at this grade level.${subtopicsLine} This topic may not be in the current textbook edition — that is fine, still teach it.

Only respond with {"unknown":true} (and nothing else) if "${topic}" is not intelligible or not a real school topic at all — never merely because it is absent from a specific textbook.`;

  return `${anchor}

${calibrationNote ? `${calibrationNote}\n\n` : ''}Otherwise produce ONLY valid JSON matching this exact top-level shape (no markdown fences, no commentary):
{"whatYoullLearn": ["...", "..."], "blocks": [ {"type": "...", ...fields...}, ... ]}

EXACT FIELD SHAPES (use these field names precisely):
${BLOCK_SHAPES}

ALLOWED BLOCK TYPES FOR THIS SUBJECT:
${guidance}

${RECIPE_RULES}
${neutralSourceNote(input)}${mustCoverNote(input)}${qualityFeedbackNote(input)}
Respond with ONLY the JSON object described above.`;
}

function buildPrompt(input) {
  if (input.mode === 'knowledge') return buildKnowledgePrompt(input);
  const { curriculum, grade, subject, chapterPdf, topic, primaryText, contextText, contentType } = input;
  const guidance = CONTENT_TYPE_GUIDANCE[contentType] || CONTENT_TYPE_GUIDANCE.theory;
  const calibrationNote = gradeCalibrationNote(grade);
  return `${COMMON_RULES}

${calibrationNote ? `${calibrationNote}\n\n` : ''}EXACT FIELD SHAPES (use these field names precisely):
${BLOCK_SHAPES}

ALLOWED BLOCK TYPES FOR THIS SUBJECT:
${guidance}

${RECIPE_RULES}

CURRICULUM: ${curriculum}
GRADE: ${grade}
SUBJECT: ${subject}
TEXTBOOK: ${chapterPdf || 'unknown'}
TOPIC: ${topic}

SOURCE TEXT (this topic's actual textbook content — the only thing you may claim this topic teaches):
"""
${primaryText}
"""

CONTEXT TEXT (neighboring textbook material, background only, NOT this topic's own content):
"""
${contextText || '(none)'}
"""
${neutralSourceNote(input)}${mustCoverNote(input)}${qualityFeedbackNote(input)}
Respond with ONLY the JSON object described in rule 4.`;
}

// Thin wrapper kept for callers/tests that import callGroq by name — the
// actual provider fallback chain lives in services/llm/fallback.js.
async function callGroq(prompt) {
  const content = await callWithFallback(prompt, { json: true, temperature: 0.3 });
  return { choices: [{ message: { content } }] };
}

function tryParseAndValidate(raw) {
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (e) {
    return { ok: false, reason: 'json_parse_error', raw };
  }
  if (parsed && parsed.unknown === true) {
    return { ok: false, reason: 'unknown', unknown: true };
  }
  const result = validateEnrichment(parsed);
  if (!result.valid) {
    return { ok: false, reason: 'schema_validation_failed', errors: result.errors, raw };
  }
  return { ok: true, whatYoullLearn: parsed.whatYoullLearn, blocks: result.blocks };
}

// One retry, only for a genuinely fixable failure (bad/incomplete JSON) —
// re-prompts with the exact validation errors so the model can correct
// itself, rather than blindly resending the same prompt. Never retries more
// than once: a second bad generation in a row means fall back safely
// (getOrGenerateEnrichment returns null) rather than spending more LLM calls
// chasing a topic that may just have too little source material.
async function generateStructuredContent(input) {
  const prompt = buildPrompt(input);

  const first = await callGroq(prompt);
  const firstResult = tryParseAndValidate(first.choices[0]?.message?.content || '{}');
  if (firstResult.ok) {
    const missing = checkRecipe(firstResult.blocks);
    if (missing.length === 0) return firstResult;
    return await regenerateForRecipe(prompt, missing, input.mode) || firstResult;
  }
  if (firstResult.unknown) return firstResult;

  const retryPrompt = `${prompt}

Your previous response was invalid: ${firstResult.reason}${firstResult.errors ? ' — ' + firstResult.errors.join('; ') : ''}.
Fix this and respond again with ONLY the corrected JSON object, using the EXACT field shapes given above.`;
  const second = await callGroq(retryPrompt);
  const secondResult = tryParseAndValidate(second.choices[0]?.message?.content || '{}');
  if (!secondResult.ok) return secondResult;
  const missing = checkRecipe(secondResult.blocks);
  if (missing.length === 0) return secondResult;
  return await regenerateForRecipe(prompt, missing, input.mode) || secondResult;
}

// Regenerates ONCE when the recipe is incomplete, passing back exactly what
// was missing. On any failure (or still incomplete), the caller keeps the
// original result rather than losing content over a partial recipe.
async function regenerateForRecipe(prompt, missing) {
  const retryPrompt = `${prompt}

Your previous response was missing: ${missing.join('; ')}. Respond again with the FULL corrected JSON object (same shape), this time covering every part of the LESSON RECIPE above, including what was missing.`;
  try {
    const completion = await callGroq(retryPrompt);
    const result = tryParseAndValidate(completion.choices[0]?.message?.content || '{}');
    return result.ok || result.unknown ? result : null;
  } catch {
    return null;
  }
}

/**
 * Look up a persisted enrichment row. Never throws — a Supabase hiccup is
 * treated the same as "not cached yet" so a transient DB error degrades to
 * regeneration rather than a hard failure.
 */
async function getCachedEnrichment({ curriculum, grade, subject, topic }) {
  try {
    const { data, error } = await supabase
      .from('topic_ai_enrichment')
      .select('*')
      .eq('curriculum', normalizeCurriculum(curriculum))
      .eq('grade', grade)
      .eq('subject', subject)
      .eq('topic', topic)
      .eq('schema_version', SCHEMA_VERSION)
      .maybeSingle();
    if (error || !data) return null;
    return data;
  } catch {
    return null;
  }
}

async function persistEnrichment({ curriculum, grade, subject, topic, contentType, whatYoullLearn, blocks, sourceChunkIds, sourceReference }) {
  try {
    await supabase.from('topic_ai_enrichment').upsert(
      {
        curriculum: normalizeCurriculum(curriculum), grade, subject, topic,
        content_type: contentType,
        structured_content: { whatYoullLearn, blocks },
        source_chunk_ids: sourceChunkIds,
        source_reference: sourceReference || null,
        schema_version: SCHEMA_VERSION,
        prompt_version: PROMPT_VERSION,
        model: PRIMARY_MODEL,
        updated_at: new Date().toISOString(),
      },
      { onConflict: 'curriculum,grade,subject,topic' }
    );
  } catch (e) {
    // Persistence failing must not break serving the just-generated content
    // for THIS request — it just means the next request regenerates too.
    console.error('[enrichment] persist failed:', e.message);
  }
}

/**
 * Get-or-generate. First call for a topic: Qdrant -> LLM -> validate ->
 * persist -> return. Every later call for the same
 * (curriculum, grade, subject, topic): straight from topic_ai_enrichment,
 * NO LLM call. Never throws — returns null on any failure so callers can
 * fall back to the raw intro/body pass-through rather than breaking the
 * Learn page.
 */
async function getOrGenerateEnrichment({ curriculum, grade, subject, topic }) {
  const cached = await getCachedEnrichment({ curriculum, grade, subject, topic });
  if (cached) {
    return {
      whatYoullLearn: cached.structured_content?.whatYoullLearn || [],
      blocks: cached.structured_content?.blocks || [],
      contentType: cached.content_type,
      pdfPage: cached.structured_content?.pdfPage,
      listenScript: cached.structured_content?.listenScript,
      mathTutor: cached.structured_content?.mathTutor,
      cached: true,
    };
  }

  try {
    const { resolveTopicWithContext } = require('../qdrant');
    const retrieved = await resolveTopicWithContext(curriculum, grade, subject, topic);
    if (!retrieved || !retrieved.primary.length) return null;

    const contentType = classifyContentType(subject);
    const primaryText = retrieved.primary.map((c) => c.text).join('\n\n');
    const contextText = retrieved.context.map((c) => c.text).join('\n\n');

    const generated = await generateStructuredContent({
      curriculum, grade, subject, topic, contentType,
      chapterPdf: retrieved.pdfFile,
      primaryText, contextText,
    });

    if (!generated.ok) {
      console.error('[enrichment] generation failed:', generated.reason, generated.errors || '');
      return null;
    }

    const sourceChunkIds = [...retrieved.primary.map((c) => c.id), ...retrieved.context.map((c) => c.id)];
    await persistEnrichment({
      curriculum, grade, subject, topic, contentType,
      whatYoullLearn: generated.whatYoullLearn, blocks: generated.blocks,
      sourceChunkIds, sourceReference: retrieved.sourceReference,
    });

    return { whatYoullLearn: generated.whatYoullLearn, blocks: generated.blocks, contentType, cached: false };
  } catch (e) {
    console.error('[enrichment] getOrGenerateEnrichment failed:', e.message);
    return null;
  }
}

module.exports = { getOrGenerateEnrichment, getCachedEnrichment, classifyContentType, generateStructuredContent, buildPrompt, checkRecipe };
