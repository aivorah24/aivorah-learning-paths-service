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
const Groq = require('groq-sdk');
const supabase = require('../supabase');
const { validateEnrichment } = require('./blockSchema');

const groq = new Groq({ apiKey: process.env.GROQ_API_KEY });

const SCHEMA_VERSION = 1;
const PROMPT_VERSION = 'v1';
// Same models already proven working elsewhere in this stack (see
// aivorah-assignments-service/routes/assignments.js's quiz generation) —
// primary 120b model, falling back to the 8B-class 20b model on failure/
// rate-limit so generation doesn't dead-end when the daily cap is hit.
const PRIMARY_MODEL = 'openai/gpt-oss-120b';
const FALLBACK_MODEL = 'openai/gpt-oss-20b';

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
Use these EXACT field names for whichever types you use — do not rename "text" to "content", do not flatten {term, definition} items into a plain string array, do not omit "type".`;

const CONTENT_TYPE_GUIDANCE = {
  theory: `Use these block types as appropriate: overview, explanation, key_terms, key_points, example, activity, tip.
Do not force every block type — only include a block if the source material actually supports it.`,
  mathematics: `Use these block types as appropriate: overview, explanation, key_terms, formula, worked_example, key_points, activity, common_mistake.
If the source contains a worked problem/example sum, you MUST produce a "worked_example" block — never just state the final answer. "steps" needs one entry per real step, and "why" must explain the reasoning, not just restate the arithmetic.
Write equations/expressions as LaTeX-compatible strings (e.g. "x^2 + 3x - 4 = 0", "\\\\frac{a}{b}") — never flatten them into ambiguous plain text.`,
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
8. Never produce an empty blocks array — if the source is thin, still produce at least an "explanation" block grounded in exactly what's there.`;

function buildPrompt({ curriculum, grade, subject, chapterPdf, topic, primaryText, contextText, contentType }) {
  const guidance = CONTENT_TYPE_GUIDANCE[contentType] || CONTENT_TYPE_GUIDANCE.theory;
  return `${COMMON_RULES}

EXACT FIELD SHAPES (use these field names precisely):
${BLOCK_SHAPES}

ALLOWED BLOCK TYPES FOR THIS SUBJECT:
${guidance}

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

Respond with ONLY the JSON object described in rule 4.`;
}

async function callGroq(prompt) {
  const opts = {
    messages: [{ role: 'user', content: prompt }],
    response_format: { type: 'json_object' },
    temperature: 0.3,
  };
  try {
    return await groq.chat.completions.create({ model: PRIMARY_MODEL, ...opts });
  } catch (primaryErr) {
    return await groq.chat.completions.create({ model: FALLBACK_MODEL, ...opts });
  }
}

function tryParseAndValidate(raw) {
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (e) {
    return { ok: false, reason: 'json_parse_error', raw };
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
  if (firstResult.ok) return firstResult;

  const retryPrompt = `${prompt}

Your previous response was invalid: ${firstResult.reason}${firstResult.errors ? ' — ' + firstResult.errors.join('; ') : ''}.
Fix this and respond again with ONLY the corrected JSON object, using the EXACT field shapes given above.`;
  const second = await callGroq(retryPrompt);
  return tryParseAndValidate(second.choices[0]?.message?.content || '{}');
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
      .eq('curriculum', curriculum)
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
        curriculum, grade, subject, topic,
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

module.exports = { getOrGenerateEnrichment, getCachedEnrichment, classifyContentType, generateStructuredContent, buildPrompt };
