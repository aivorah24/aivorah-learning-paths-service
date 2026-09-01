// Unit tests for services/curriculum/enrichment.js — the AI pilot's
// get-or-generate orchestration. Groq, Supabase, and Qdrant are all mocked;
// no real network call happens in this suite.

const mockCreate = jest.fn();
jest.mock('groq-sdk', () => jest.fn().mockImplementation(() => ({
  chat: { completions: { create: (...args) => mockCreate(...args) } },
})));

const mockChain = {
  select: jest.fn().mockReturnThis(),
  eq: jest.fn().mockReturnThis(),
  maybeSingle: jest.fn(),
  upsert: jest.fn().mockResolvedValue({ data: null, error: null }),
};
jest.mock('../../services/supabase', () => ({ from: jest.fn(() => mockChain) }));

const mockResolveTopicWithContext = jest.fn();
jest.mock('../../services/qdrant', () => ({
  resolveTopicWithContext: (...args) => mockResolveTopicWithContext(...args),
}));

const { getOrGenerateEnrichment, classifyContentType } = require('../../services/curriculum/enrichment');

function groqReturns(jsonObj) {
  mockCreate.mockResolvedValueOnce({ choices: [{ message: { content: JSON.stringify(jsonObj) } }] });
}

const VALID_PAYLOAD = {
  whatYoullLearn: ['What relevant information means for decision-making'],
  blocks: [{ type: 'explanation', text: 'Information is relevant if it can change a decision.' }],
};

const RETRIEVAL_RESULT = {
  primary: [{ id: 'p1', text: 'Relevance of Information... capable of making a difference.', chunkIndex: 12 }],
  context: [{ id: 'c1', text: 'Users of Accounting Information...', topic: 'Users of Accounting Information' }],
  sourceReference: 'NCERT Accountancy Grade 11 | keac101.pdf',
  pdfFile: 'keac101.pdf',
  images: [],
};

beforeEach(() => {
  jest.clearAllMocks();
  mockChain.maybeSingle.mockResolvedValue({ data: null, error: null });
  mockChain.upsert.mockResolvedValue({ data: null, error: null });
});

describe('classifyContentType', () => {
  test('maps known subjects to their content type', () => {
    expect(classifyContentType('Mathematics')).toBe('mathematics');
    expect(classifyContentType('Physics')).toBe('physics');
    expect(classifyContentType('Chemistry')).toBe('chemistry');
    expect(classifyContentType('Biology')).toBe('biology');
    expect(classifyContentType('English')).toBe('language');
    expect(classifyContentType('Accountancy')).toBe('theory');
    expect(classifyContentType('Some Brand New Subject')).toBe('theory');
  });
});

describe('getOrGenerateEnrichment', () => {
  test('1. a Qdrant-only topic with no cache generates real structured content via the LLM', async () => {
    mockResolveTopicWithContext.mockResolvedValueOnce(RETRIEVAL_RESULT);
    groqReturns(VALID_PAYLOAD);

    const result = await getOrGenerateEnrichment({ curriculum: 'CBSE', grade: 'Grade 11', subject: 'Accountancy', topic: 'Relevance of Information' });

    expect(result).not.toBeNull();
    expect(result.blocks).toHaveLength(1);
    expect(result.whatYoullLearn).toEqual(VALID_PAYLOAD.whatYoullLearn);
    expect(result.cached).toBe(false);
    expect(mockCreate).toHaveBeenCalledTimes(1);
  });

  test('2. generated JSON is schema-validated — a malformed worked_example never reaches persistence', async () => {
    mockResolveTopicWithContext.mockResolvedValueOnce(RETRIEVAL_RESULT);
    groqReturns({ whatYoullLearn: ['x'], blocks: [{ type: 'worked_example', problem: 'x' /* no steps, no finalAnswer */ }] });

    const result = await getOrGenerateEnrichment({ curriculum: 'CBSE', grade: 'Grade 11', subject: 'Mathematics', topic: 'Bad Topic' });

    expect(result).toBeNull();
    expect(mockChain.upsert).not.toHaveBeenCalled();
  });

  test('3. a persisted enrichment is reused on the second request', async () => {
    mockChain.maybeSingle.mockResolvedValueOnce({
      data: {
        structured_content: VALID_PAYLOAD,
        content_type: 'theory',
      },
      error: null,
    });

    const result = await getOrGenerateEnrichment({ curriculum: 'CBSE', grade: 'Grade 11', subject: 'Accountancy', topic: 'Relevance of Information' });

    expect(result.cached).toBe(true);
    expect(result.blocks).toEqual(VALID_PAYLOAD.blocks);
  });

  test('4. the second (cached) request never calls the LLM', async () => {
    mockChain.maybeSingle.mockResolvedValueOnce({ data: { structured_content: VALID_PAYLOAD, content_type: 'theory' }, error: null });

    await getOrGenerateEnrichment({ curriculum: 'CBSE', grade: 'Grade 11', subject: 'Accountancy', topic: 'Relevance of Information' });

    expect(mockCreate).not.toHaveBeenCalled();
    expect(mockResolveTopicWithContext).not.toHaveBeenCalled();
  });

  test('5. invalid/unparseable AI output is handled safely — returns null, does not throw, does not persist', async () => {
    mockResolveTopicWithContext.mockResolvedValueOnce(RETRIEVAL_RESULT);
    mockCreate.mockResolvedValueOnce({ choices: [{ message: { content: 'not valid json {{{' } }] });

    await expect(
      getOrGenerateEnrichment({ curriculum: 'CBSE', grade: 'Grade 11', subject: 'Accountancy', topic: 'X' })
    ).resolves.toBeNull();
    expect(mockChain.upsert).not.toHaveBeenCalled();
  });

  test('6. missing/insufficient Qdrant source (no primary chunk) is handled safely — no LLM call, returns null', async () => {
    mockResolveTopicWithContext.mockResolvedValueOnce(null);

    const result = await getOrGenerateEnrichment({ curriculum: 'CBSE', grade: 'Grade 11', subject: 'Accountancy', topic: 'Nonexistent' });

    expect(result).toBeNull();
    expect(mockCreate).not.toHaveBeenCalled();
  });

  test('a Groq outage degrades to null, never throws, never breaks the caller', async () => {
    mockResolveTopicWithContext.mockResolvedValueOnce(RETRIEVAL_RESULT);
    mockCreate.mockRejectedValueOnce(new Error('Groq is down'));

    await expect(
      getOrGenerateEnrichment({ curriculum: 'CBSE', grade: 'Grade 11', subject: 'Accountancy', topic: 'X' })
    ).resolves.toBeNull();
  });

  test('a real, successful generation is persisted with source chunk ids and the classified content type', async () => {
    mockResolveTopicWithContext.mockResolvedValueOnce(RETRIEVAL_RESULT);
    groqReturns(VALID_PAYLOAD);

    await getOrGenerateEnrichment({ curriculum: 'CBSE', grade: 'Grade 11', subject: 'Accountancy', topic: 'Relevance of Information' });

    expect(mockChain.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        curriculum: 'CBSE', grade: 'Grade 11', subject: 'Accountancy', topic: 'Relevance of Information',
        content_type: 'theory',
        source_chunk_ids: ['p1', 'c1'],
      }),
      { onConflict: 'curriculum,grade,subject,topic' }
    );
  });
});
