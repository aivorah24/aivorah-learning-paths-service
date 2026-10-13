// Shared cross-teacher cache for finished learning-path topic generations —
// 15 teachers uploading the same Grade 6 CBSE Maths topics generate each
// topic ONCE. Backed by public.topic_generation_cache (see
// aivorah-db/supabase/migrations/0005_topic_generation_cache.sql — that
// migration must be applied before this cache is live; until then every
// read/write below fails silently and generation just runs every time).
const crypto = require('crypto');
const supabase = require('../supabase');
const { normalizeCurriculum } = require('../curriculumName');

// Bump to invalidate every cached entry (prompt/recipe/schema change).
const PIPELINE_VERSION = 2;

function normalize(s) {
  return String(s || '').trim().toLowerCase().replace(/\s+/g, ' ');
}

// Excludes unitTitle; subtopics are order-independent. Matched book sections and the teacher's own text are part of the key.
function buildCacheKey(metadata, ref) {
  const subtopicsKey = (ref.subtopics || []).map(normalize).filter(Boolean).sort().join('|');
  return [
    normalize(normalizeCurriculum(metadata?.curriculum || 'CBSE')),
    normalize(metadata?.grade),
    normalize(metadata?.subject),
    normalize(ref.topicTitle),
    subtopicsKey,
    (ref.bookSections || []).map((b) => `${b.pdfFile}#${b.title}`).join('|'),
    ref.sourceContext ? crypto.createHash('sha1').update(ref.sourceContext).digest('hex').slice(0, 12) : '',
    PIPELINE_VERSION,
  ].join('::');
}

/**
 * Never throws — a cache miss and a cache error are treated identically so a
 * Supabase hiccup just means "generate it" rather than breaking the upload.
 */
async function getCachedTopic(cacheKey) {
  try {
    const { data, error } = await supabase
      .from('topic_generation_cache')
      .select('payload')
      .eq('cache_key', cacheKey)
      .maybeSingle();
    if (error || !data) return null;
    return data.payload || null;
  } catch (e) {
    console.error('[topicCache] read failed:', e.message);
    return null;
  }
}

// Only 'ready' topics are ever cached — needs_teacher_input/failed topics
// must always regenerate, they were never actually usable content.
async function persistCachedTopic(cacheKey, { curriculum, grade, subject, topic, payload }) {
  if (payload?.status !== 'ready') return;
  try {
    await supabase.from('topic_generation_cache').upsert(
      {
        cache_key: cacheKey,
        curriculum: normalizeCurriculum(curriculum || 'CBSE'),
        grade: String(grade || ''),
        subject: subject || '',
        topic,
        pipeline_version: PIPELINE_VERSION,
        payload,
        updated_at: new Date().toISOString(),
      },
      { onConflict: 'cache_key' }
    );
  } catch (e) {
    console.error('[topicCache] write failed:', e.message);
  }
}

// In-memory promise map — dedupes identical topics generating concurrently,
// within one draft and across simultaneous uploads in the same process, so
// two teachers uploading at once never both pay for the same generation.
const inFlight = new Map();
function dedupeGeneration(cacheKey, generateFn) {
  if (inFlight.has(cacheKey)) return inFlight.get(cacheKey);
  const promise = Promise.resolve()
    .then(generateFn)
    .finally(() => inFlight.delete(cacheKey));
  inFlight.set(cacheKey, promise);
  return promise;
}

module.exports = { PIPELINE_VERSION, buildCacheKey, getCachedTopic, persistCachedTopic, dedupeGeneration };
