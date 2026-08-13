const supabase = require('../../services/supabase');
const { RESOURCE_TYPES } = require('./types');

/**
 * Resolve one resource for a topic, trying tiers in priority order:
 * Official Book -> Licensed Content -> Mapped OER -> Original AI -> Placeholder.
 * NEVER throws — always returns a well-formed LearningResource, falling
 * through to a COMING_SOON placeholder if nothing else resolves.
 *
 * @param {{ topicId: string, resourceType: import('./types').ResourceType, legacyResolver?: () => Promise<import('./types').LearningResource|null> }} args
 *   `legacyResolver` is an optional hook a provider can pass to check its
 *   own pre-topic_resources data source first (e.g. the CBSE provider's
 *   direct Qdrant read for content that predates this table) — see
 *   providers/cbseProvider.js.
 * @returns {Promise<import('./types').LearningResource>}
 */
async function resolveResource({ topicId, resourceType, legacyResolver }) {
  const placeholder = () => ({
    id: `${topicId}:${resourceType}:placeholder`,
    topicId,
    resourceType,
    status: 'COMING_SOON',
    sourceTier: 'PLACEHOLDER',
    source: null,
    payload: null,
  });

  try {
    // A provider-supplied legacy resolver gets first look — this is how the
    // CBSE provider serves its existing pre-topic_resources Qdrant content
    // without this generic path needing to know anything about Qdrant.
    if (legacyResolver) {
      const legacy = await legacyResolver();
      if (legacy) return legacy;
    }

    if (!topicId) return placeholder();

    const { data, error } = await supabase
      .from('topic_resources')
      .select('*')
      .eq('topic_id', topicId)
      .eq('resource_type', resourceType)
      .maybeSingle();

    if (error || !data) return placeholder();

    // A row exists but isn't actually ready (COMING_SOON/UNDER_REVIEW/NOT_AVAILABLE
    // as explicitly recorded) — report it honestly rather than falling through
    // to a generic placeholder, since the row may carry a specific `source`.
    if (data.status !== 'READY') {
      return {
        id: data.id,
        topicId,
        resourceType,
        status: data.status,
        sourceTier: data.source_tier || null,
        source: data.source || null,
        payload: data.static_payload || null,
      };
    }

    return {
      id: data.id,
      topicId,
      resourceType,
      status: 'READY',
      sourceTier: data.source_tier,
      source: data.source,
      payload: data.static_payload || null,
    };
  } catch {
    // Infra hiccup (Supabase down, etc.) — degrade to placeholder rather
    // than surfacing a 500 for a resource-availability check.
    return placeholder();
  }
}

/**
 * Resolve all 8 resource types for a topic in parallel.
 * @param {{ topicId: string, legacyResolvers?: Partial<Record<import('./types').ResourceType, () => Promise<import('./types').LearningResource|null>>> }} args
 * @returns {Promise<import('./types').LearningResource[]>}
 */
async function resolveAllResources({ topicId, legacyResolvers = {} }) {
  return Promise.all(
    RESOURCE_TYPES.map((resourceType) =>
      resolveResource({ topicId, resourceType, legacyResolver: legacyResolvers[resourceType] })
    )
  );
}

module.exports = { resolveResource, resolveAllResources };
