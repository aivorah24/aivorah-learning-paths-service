// Hand-rolled structural validator for the AI enrichment pilot's structured
// content — no JSON-schema library (ajv/zod/joi) exists anywhere in this
// project's services (checked every aivorah-*/package.json before adding
// one), so this follows the existing convention of small, explicit checks
// rather than introducing a new dependency for one feature.
//
// Design note: this is intentionally a generic block list, not one giant
// "simplifiedExplanation" string — each block has a `type` the frontend
// renderer switches on, so subject-specific shapes (worked_example,
// chemical_equation, poem_line, ...) can render differently while sharing
// one storage/transport shape. See resolveResourcesByTopicName /
// LearningBlocks.tsx for the two ends of this contract.

const isNonEmptyString = (v) => typeof v === 'string' && v.trim().length > 0;
const isStringArray = (v) => Array.isArray(v) && v.every((x) => isNonEmptyString(x));

// Each validator returns true/false — kept forgiving on optional fields
// (undefined is fine) but strict on the fields that give the block its
// meaning, since a block missing its core content is worse than no block.
const BLOCK_VALIDATORS = {
  overview: (b) => isNonEmptyString(b.text),
  explanation: (b) => isNonEmptyString(b.text),
  key_terms: (b) => Array.isArray(b.items) && b.items.length > 0 &&
    b.items.every((i) => isNonEmptyString(i.term) && isNonEmptyString(i.definition)),
  key_points: (b) => isStringArray(b.items) && b.items.length > 0,
  example: (b) => isNonEmptyString(b.text),
  // Two step shapes are accepted: the legacy {action, why, equation?} shape
  // (still produced by enrichment.js's generic worked_example prompt, used by
  // the pre-existing topic_ai_enrichment pipeline — never broken by this
  // change), and the newer {step_number, explanation, calculation} shape
  // (services/curriculumUpload/aiGeneration.js + mathValidator.js), which
  // gives arithmetic verification a real "calculation" expression to check.
  // A step only needs to satisfy ONE of the two shapes.
  worked_example: (b) =>
    isNonEmptyString(b.problem) &&
    Array.isArray(b.steps) && b.steps.length > 0 &&
    b.steps.every((s) =>
      (isNonEmptyString(s.action) && isNonEmptyString(s.why)) ||
      (isNonEmptyString(s.explanation) && isNonEmptyString(s.calculation) && typeof s.step_number === 'number')
    ) &&
    isNonEmptyString(b.finalAnswer),
  formula: (b) => isNonEmptyString(b.name) && isNonEmptyString(b.expression),
  chemical_equation: (b) => isNonEmptyString(b.equation),
  process: (b) => isStringArray(b.steps) && b.steps.length > 0,
  comparison: (b) => Array.isArray(b.items) && b.items.length > 0,
  poem_line: (b) => isNonEmptyString(b.sourceText) && isNonEmptyString(b.explanation),
  prose_excerpt: (b) => isNonEmptyString(b.sourceText) && isNonEmptyString(b.explanation),
  vocabulary: (b) => Array.isArray(b.items) && b.items.length > 0 &&
    b.items.every((i) => isNonEmptyString(i.term) && isNonEmptyString(i.meaning)),
  activity: (b) => isNonEmptyString(b.text),
  tip: (b) => isNonEmptyString(b.text),
  common_mistake: (b) => isNonEmptyString(b.text),
  // Image/visual passthrough — populated from rag.js's buildImages() output
  // (url/image_path resolved server-side, never invented by the LLM prompt).
  image: (b) => isNonEmptyString(b.url) && isNonEmptyString(b.caption),
  visual_representation: (b) => isNonEmptyString(b.url) && isNonEmptyString(b.caption),
  // History/Civics/Geography structuring (Task 2's CONTENT_TYPE_GUIDANCE
  // expansion asks for these three for "theory" content when applicable).
  timeline: (b) => Array.isArray(b.events) && b.events.length > 0 &&
    b.events.every((e) => isNonEmptyString(e.date) && isNonEmptyString(e.description)),
  cause_and_effect: (b) => Array.isArray(b.items) && b.items.length > 0 &&
    b.items.every((i) => isNonEmptyString(i.cause) && isNonEmptyString(i.effect)),
  case_study: (b) => isNonEmptyString(b.title) && isNonEmptyString(b.text),
  // Structured tabular data (e.g. a Place Value Chart) for when no grounded
  // image is available — Markdown-table-style rows/headers, never a raster
  // image the LLM can't actually produce.
  table: (b) => isStringArray(b.headers) && Array.isArray(b.rows) && b.rows.length > 0 &&
    b.rows.every((r) => isStringArray(r) && r.length === b.headers.length),
};

const VALID_TYPES = Object.keys(BLOCK_VALIDATORS);

function validateBlock(block) {
  if (!block || typeof block !== 'object' || !isNonEmptyString(block.type)) return false;
  const validator = BLOCK_VALIDATORS[block.type];
  return Boolean(validator && validator(block));
}

/**
 * Validates one AI-generated enrichment payload before it's ever persisted
 * or served. Never throws — returns { valid, errors, blocks } where `blocks`
 * is the subset of input blocks that passed (so one malformed block doesn't
 * have to invalidate an otherwise-good generation), and `valid` is only true
 * when at least one block survived AND `whatYoullLearn` is present.
 */
function validateEnrichment(payload) {
  const errors = [];
  if (!payload || typeof payload !== 'object') {
    return { valid: false, errors: ['payload is not an object'], blocks: [] };
  }
  if (!isStringArray(payload.whatYoullLearn) || payload.whatYoullLearn.length === 0) {
    errors.push('whatYoullLearn must be a non-empty array of strings');
  }
  if (!Array.isArray(payload.blocks)) {
    return { valid: false, errors: [...errors, 'blocks must be an array'], blocks: [] };
  }

  const goodBlocks = [];
  payload.blocks.forEach((block, i) => {
    if (!block || typeof block !== 'object' || !isNonEmptyString(block.type)) {
      errors.push(`blocks[${i}]: missing/invalid type`);
      return;
    }
    const validator = BLOCK_VALIDATORS[block.type];
    if (!validator) {
      errors.push(`blocks[${i}]: unknown type "${block.type}"`);
      return;
    }
    if (!validator(block)) {
      errors.push(`blocks[${i}]: type "${block.type}" failed required-field check`);
      return;
    }
    goodBlocks.push(block);
  });

  return {
    valid: errors.filter((e) => !e.startsWith('blocks[')).length === 0 && goodBlocks.length > 0,
    errors,
    blocks: goodBlocks,
  };
}

module.exports = { validateEnrichment, validateBlock, VALID_TYPES };
