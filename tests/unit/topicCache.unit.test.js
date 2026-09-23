// Unit tests for services/curriculumUpload/topicCache.js — the shared
// cross-teacher generation cache. Supabase is mocked; no real network call.
const mockChain = {
  select: jest.fn().mockReturnThis(),
  eq: jest.fn().mockReturnThis(),
  maybeSingle: jest.fn(),
  upsert: jest.fn().mockResolvedValue({ data: null, error: null }),
};
jest.mock('../../services/supabase', () => ({ from: jest.fn(() => mockChain) }));

const { PIPELINE_VERSION, buildCacheKey, getCachedTopic, persistCachedTopic } = require('../../services/curriculumUpload/topicCache');

beforeEach(() => {
  jest.clearAllMocks();
  mockChain.maybeSingle.mockResolvedValue({ data: null, error: null });
  mockChain.upsert.mockResolvedValue({ data: null, error: null });
});

const METADATA = { curriculum: 'CBSE', grade: '6', subject: 'Mathematics' };
const REF = { topicTitle: 'Whole Numbers', subtopics: ['Successor', 'Predecessor'] };

describe('buildCacheKey', () => {
  test('is stable under case/whitespace differences', () => {
    const a = buildCacheKey(METADATA, REF);
    const b = buildCacheKey(
      { curriculum: ' cbse ', grade: '6', subject: 'mathematics' },
      { topicTitle: '  whole   numbers  ', subtopics: ['successor', 'predecessor'] }
    );
    expect(a).toBe(b);
  });

  test('is stable regardless of subtopic order', () => {
    const a = buildCacheKey(METADATA, { topicTitle: 'Whole Numbers', subtopics: ['Successor', 'Predecessor'] });
    const b = buildCacheKey(METADATA, { topicTitle: 'Whole Numbers', subtopics: ['Predecessor', 'Successor'] });
    expect(a).toBe(b);
  });

  test('does NOT depend on unit title', () => {
    const a = buildCacheKey(METADATA, { ...REF, unitTitle: 'Numbers' });
    const b = buildCacheKey(METADATA, { ...REF, unitTitle: 'A Different Unit Name' });
    expect(a).toBe(b);
  });

  test('changes when the topic title changes', () => {
    const a = buildCacheKey(METADATA, REF);
    const b = buildCacheKey(METADATA, { ...REF, topicTitle: 'Fractions' });
    expect(a).not.toBe(b);
  });

  test('includes PIPELINE_VERSION so a version bump changes the key', () => {
    const key = buildCacheKey(METADATA, REF);
    expect(key).toContain(String(PIPELINE_VERSION));
  });
});

describe('getCachedTopic', () => {
  test('miss returns null', async () => {
    mockChain.maybeSingle.mockResolvedValueOnce({ data: null, error: null });
    const result = await getCachedTopic('some-key');
    expect(result).toBeNull();
  });

  test('hit returns the stored payload', async () => {
    const payload = { status: 'ready', content: { blocks: [] } };
    mockChain.maybeSingle.mockResolvedValueOnce({ data: { payload }, error: null });
    const result = await getCachedTopic('some-key');
    expect(result).toEqual(payload);
  });

  test('a Supabase error is treated as a miss, never throws', async () => {
    mockChain.maybeSingle.mockRejectedValueOnce(new Error('connection reset'));
    await expect(getCachedTopic('some-key')).resolves.toBeNull();
  });
});

describe('persistCachedTopic', () => {
  test('a ready topic is upserted', async () => {
    await persistCachedTopic('k1', { curriculum: 'CBSE', grade: '6', subject: 'Mathematics', topic: 'Whole Numbers', payload: { status: 'ready' } });
    expect(mockChain.upsert).toHaveBeenCalledWith(
      expect.objectContaining({ cache_key: 'k1', pipeline_version: PIPELINE_VERSION }),
      { onConflict: 'cache_key' }
    );
  });

  test('needs_teacher_input is never cached', async () => {
    await persistCachedTopic('k1', { payload: { status: 'needs_teacher_input' } });
    expect(mockChain.upsert).not.toHaveBeenCalled();
  });

  test('a Supabase write error never throws', async () => {
    mockChain.upsert.mockRejectedValueOnce(new Error('write failed'));
    await expect(persistCachedTopic('k1', { payload: { status: 'ready' } })).resolves.toBeUndefined();
  });
});
