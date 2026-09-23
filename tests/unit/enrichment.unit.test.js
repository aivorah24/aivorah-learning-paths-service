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

const { getOrGenerateEnrichment, classifyContentType, buildPrompt, generateStructuredContent, checkRecipe } = require('../../services/curriculum/enrichment');

function groqReturns(jsonObj) {
  mockCreate.mockResolvedValueOnce({ choices: [{ message: { content: JSON.stringify(jsonObj) } }] });
}

// Satisfies the full lesson recipe (checkRecipe) so these tests exercise
// exactly one LLM call, not the recipe regenerate-once path.
const VALID_PAYLOAD = {
  whatYoullLearn: ['What relevant information means for decision-making'],
  blocks: [
    { type: 'overview', text: 'Why does relevant information matter for a decision?' },
    { type: 'explanation', text: 'Information is relevant if it can change a decision.' },
    { type: 'example', text: 'Priya in Mumbai checks her bank balance before buying a train ticket.' },
    { type: 'table', caption: 'x', headers: ['A', 'B'], rows: [['1', '2']] },
    { type: 'activity', text: 'List two decisions you made today using information.' },
    { type: 'common_mistake', text: 'Confusing relevant with reliable information.' },
    { type: 'key_terms', items: [{ term: 'Relevance', definition: 'Capable of changing a decision.' }] },
    { type: 'key_points', items: ['What makes information relevant?', 'Why must it be timely?'] },
  ],
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
    expect(result.blocks).toHaveLength(VALID_PAYLOAD.blocks.length);
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

describe('buildPrompt grade calibration wiring', () => {
  test('a young grade injects the Foundational calibration note into the GROUNDED prompt', () => {
    const prompt = buildPrompt({ curriculum: 'NCERT', grade: '2', subject: 'Mathematics', topic: 'Counting', primaryText: 'x', contextText: '', contentType: 'mathematics' });
    expect(prompt).toMatch(/GRADE CALIBRATION \(Foundational/);
  });

  test('a higher grade injects the Secondary calibration note', () => {
    const prompt = buildPrompt({ curriculum: 'NCERT', grade: '10', subject: 'Physics', topic: 'Motion', primaryText: 'x', contextText: '', contentType: 'physics' });
    expect(prompt).toMatch(/GRADE CALIBRATION \(Secondary/);
  });

  test('no grade omits the calibration note without breaking the prompt', () => {
    const prompt = buildPrompt({ curriculum: 'NCERT', subject: 'Physics', topic: 'Motion', primaryText: 'x', contextText: '', contentType: 'physics' });
    expect(prompt).not.toMatch(/GRADE CALIBRATION/);
  });

  test('theory content type mentions timeline/cause_and_effect/case_study for History-shaped content', () => {
    const prompt = buildPrompt({ curriculum: 'NCERT', grade: '8', subject: 'History', topic: 'The Revolt of 1857', primaryText: 'x', contextText: '', contentType: 'theory' });
    expect(prompt).toMatch(/timeline/);
    expect(prompt).toMatch(/cause_and_effect/);
    expect(prompt).toMatch(/case_study/);
  });
});

describe('buildPrompt dual-concept and Indian place-value instructions', () => {
  test('always includes the dual/composite concept instruction, regardless of topic title', () => {
    const prompt = buildPrompt({ curriculum: 'NCERT', grade: '6', subject: 'Mathematics', topic: 'Place Value and Face Value', primaryText: 'x', contextText: '', contentType: 'mathematics' });
    expect(prompt).toMatch(/DUAL\/COMPOSITE CONCEPTS/);
    expect(prompt).toMatch(/every named concept/i);
  });

  test('always includes the Indian Place Value System instruction', () => {
    const prompt = buildPrompt({ curriculum: 'NCERT', grade: '6', subject: 'Mathematics', topic: 'Place Value and Face Value', primaryText: 'x', contextText: '', contentType: 'mathematics' });
    expect(prompt).toMatch(/INDIAN PLACE VALUE SYSTEM/);
    expect(prompt).toMatch(/9,63,001/);
  });

  test('mathematics guidance offers a table block as the no-image fallback', () => {
    const prompt = buildPrompt({ curriculum: 'NCERT', grade: '6', subject: 'Mathematics', topic: 'Place Value and Face Value', primaryText: 'x', contextText: '', contentType: 'mathematics' });
    expect(prompt).toMatch(/"table"/);
    expect(prompt).toMatch(/Place Value Chart/);
  });
});

describe('generateStructuredContent — knowledge mode', () => {
  const knowledgeInput = {
    mode: 'knowledge',
    curriculum: 'CBSE',
    grade: '6',
    subject: 'Science',
    chapterTitle: 'Food: Where Does It Come From?',
    topic: 'Sources of Food',
    contentType: 'biology',
  };

  beforeEach(() => {
    global.fetch = jest.fn();
    process.env.KNOWLEDGE_LLM_API_KEY = 'test-key';
  });
  afterEach(() => {
    delete global.fetch;
    delete process.env.KNOWLEDGE_LLM_API_KEY;
  });

  test('uses the knowledge-tier LLM (not Groq) on success', async () => {
    global.fetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ choices: [{ message: { content: JSON.stringify(VALID_PAYLOAD) } }] }),
    });

    const result = await generateStructuredContent(knowledgeInput);

    expect(result.ok).toBe(true);
    expect(global.fetch).toHaveBeenCalledTimes(1);
    expect(mockCreate).not.toHaveBeenCalled();
  });

  test('falls back to Groq when the knowledge-tier LLM errors (e.g. 429)', async () => {
    global.fetch.mockResolvedValueOnce({ ok: false, status: 429, text: async () => 'rate limited' });
    groqReturns(VALID_PAYLOAD);

    const result = await generateStructuredContent(knowledgeInput);

    expect(result.ok).toBe(true);
    expect(global.fetch).toHaveBeenCalledTimes(1);
    expect(mockCreate).toHaveBeenCalledTimes(1);
  });

  test('{"unknown":true} short-circuits without a retry', async () => {
    global.fetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ choices: [{ message: { content: '{"unknown":true}' } }] }),
    });

    const result = await generateStructuredContent(knowledgeInput);

    expect(result.ok).toBe(false);
    expect(result.unknown).toBe(true);
    expect(mockCreate).not.toHaveBeenCalled();
  });
});

describe('checkRecipe', () => {
  test('a full recipe reports nothing missing', () => {
    expect(checkRecipe(VALID_PAYLOAD.blocks)).toEqual([]);
  });

  test('flags every missing recipe part', () => {
    const missing = checkRecipe([{ type: 'explanation', text: 'x' }]);
    expect(missing).toEqual(expect.arrayContaining([
      expect.stringContaining('hook question'),
      expect.stringContaining('Indian example'),
      expect.stringContaining('visual block'),
      expect.stringContaining('activity'),
      expect.stringContaining('common_mistake'),
      expect.stringContaining('key_terms'),
      expect.stringContaining('quick check'),
    ]));
  });

  test('an overview block that is not a question is still flagged', () => {
    const missing = checkRecipe([{ type: 'overview', text: 'This is a statement.' }]);
    expect(missing).toContain('hook question (overview block ending in "?")');
  });

  test('a key_points block with fewer than 2 questions does not count as the quick check', () => {
    const missing = checkRecipe([{ type: 'key_points', items: ['Only one question?', 'Not a question.'] }]);
    expect(missing.some((m) => m.includes('quick check'))).toBe(true);
  });
});

describe('generateStructuredContent — recipe regenerate-once', () => {
  const groundedInput = {
    curriculum: 'CBSE', grade: '6', subject: 'Science', chapterPdf: 'x.pdf',
    topic: 'Food', primaryText: 'source', contextText: '', contentType: 'biology',
  };

  test('an incomplete recipe triggers exactly one regeneration, keeping the completed result', async () => {
    const incomplete = { whatYoullLearn: ['x'], blocks: [{ type: 'explanation', text: 'x' }] };
    groqReturns(incomplete);
    groqReturns(VALID_PAYLOAD);

    const result = await generateStructuredContent(groundedInput);

    expect(result.ok).toBe(true);
    expect(result.blocks).toHaveLength(VALID_PAYLOAD.blocks.length);
    expect(mockCreate).toHaveBeenCalledTimes(2);
  });

  test('a still-incomplete regeneration falls back to the first valid result rather than failing', async () => {
    const incomplete = { whatYoullLearn: ['x'], blocks: [{ type: 'explanation', text: 'x' }] };
    groqReturns(incomplete);
    groqReturns(incomplete);

    const result = await generateStructuredContent(groundedInput);

    expect(result.ok).toBe(true);
    expect(result.blocks).toHaveLength(1);
    expect(mockCreate).toHaveBeenCalledTimes(2);
  });
});
