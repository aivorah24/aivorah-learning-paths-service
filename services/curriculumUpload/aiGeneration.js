const Groq = require('groq-sdk');

let _groq = null;
function getGroqClient() {
  if (!_groq) _groq = new Groq({ apiKey: process.env.GROQ_API_KEY });
  return _groq;
}

// Same models already proven for structured JSON generation in this service
// (services/curriculum/enrichment.js) — primary 120b, falling back to the
// 20b model on failure/rate-limit.
const PRIMARY_MODEL = 'openai/gpt-oss-120b';
const FALLBACK_MODEL = 'openai/gpt-oss-20b';

class LearningPathGenerationError extends Error {}

function collectTopicRefs(normalized) {
  const refs = [];
  normalized.units.forEach((unit) => {
    unit.topics.forEach((topic) => {
      if (!topic.title) return;
      refs.push({
        unitOrder: unit.order,
        topicOrder: topic.order,
        unitTitle: unit.title,
        topicTitle: topic.title,
        subtopics: topic.subtopics.map((s) => s.title).filter(Boolean),
      });
    });
  });
  return refs;
}

function buildPrompt(topicRefs, previousErrors) {
  const topicList = topicRefs
    .map((t) => {
      const subtopicNote = t.subtopics.length ? ` (subtopics: ${t.subtopics.join(', ')})` : '';
      return `- unitOrder=${t.unitOrder}, topicOrder=${t.topicOrder}: "${t.unitTitle || ''}" > "${t.topicTitle}"${subtopicNote}`;
    })
    .join('\n');

  const base = `You are writing learning-path content for an EXISTING curriculum outline. You must NOT invent new topics, units or subtopics — only add learning objectives and a lesson breakdown for the topics listed below, using their exact unitOrder/topicOrder pairs.

TOPICS:
${topicList}

Respond with ONLY a JSON object of this exact shape:
{"topics": [{"unitOrder": number, "topicOrder": number, "objectives": string[], "lessons": [{"title": string, "summary": string}]}]}

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
    topics.push({ unitOrder: entry.unitOrder, topicOrder: entry.topicOrder, objectives, lessons });
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

  const first = await attemptGeneration(buildPrompt(topicRefs), topicRefs);
  if (first.ok) return mergeGeneratedContent(normalized, first.topics);

  const second = await attemptGeneration(buildPrompt(topicRefs, first.errors), topicRefs);
  if (second.ok) return mergeGeneratedContent(normalized, second.topics);

  throw new LearningPathGenerationError(`AI generation failed after retry: ${second.errors.join('; ')}`);
}

module.exports = {
  generateLearningPathDraft,
  collectTopicRefs,
  validateGeneratedTopics,
  mergeGeneratedContent,
  LearningPathGenerationError,
};
