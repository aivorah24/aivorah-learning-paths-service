// Unit tests for services/curriculum/enrichment.js — the AI pilot's
// get-or-generate orchestration. Groq, Supabase, and Qdrant are all mocked;
// no real network call happens in this suite.

process.env.GROQ_API_KEY = 'test-groq-key';

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

const { resetFallbackState } = require('../../services/llm/fallback');
const { getOrGenerateEnrichment, classifyContentType, buildPrompt, generateStructuredContent, checkRecipe } = require('../../services/curriculum/enrichment');

function fetchOk(content) {
  global.fetch.mockResolvedValueOnce({ ok: true, json: async () => ({ choices: [{ message: { content: JSON.stringify(content) } }] }) });
}
function fetchErr(status, body) {
  global.fetch.mockResolvedValueOnce({ ok: false, status, text: async () => body, headers: new Map() });
}
// Kept as the name used throughout this file — now drives the fetch mock
// that callWithFallback (services/llm/fallback.js) calls under the hood.
const groqReturns = fetchOk;

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
  resetFallbackState();
  global.fetch = jest.fn();
  mockChain.maybeSingle.mockResolvedValue({ data: null, error: null });
  mockChain.upsert.mockResolvedValue({ data: null, error: null });
});
afterEach(() => {
  delete global.fetch;
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
    expect(global.fetch).toHaveBeenCalledTimes(1);
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

    expect(global.fetch).not.toHaveBeenCalled();
    expect(mockResolveTopicWithContext).not.toHaveBeenCalled();
  });

  test('5. invalid/unparseable AI output is handled safely — returns null, does not throw, does not persist', async () => {
    mockResolveTopicWithContext.mockResolvedValueOnce(RETRIEVAL_RESULT);
    global.fetch.mockResolvedValueOnce({ ok: true, json: async () => ({ choices: [{ message: { content: 'not valid json {{{' } }] }) });

    await expect(
      getOrGenerateEnrichment({ curriculum: 'CBSE', grade: 'Grade 11', subject: 'Accountancy', topic: 'X' })
    ).resolves.toBeNull();
    expect(mockChain.upsert).not.toHaveBeenCalled();
  });

  test('6. missing/insufficient Qdrant source (no primary chunk) is handled safely — no LLM call, returns null', async () => {
    mockResolveTopicWithContext.mockResolvedValueOnce(null);

    const result = await getOrGenerateEnrichment({ curriculum: 'CBSE', grade: 'Grade 11', subject: 'Accountancy', topic: 'Nonexistent' });

    expect(result).toBeNull();
    expect(global.fetch).not.toHaveBeenCalled();
  });

  test('a Groq outage degrades to null, never throws, never breaks the caller', async () => {
    mockResolveTopicWithContext.mockResolvedValueOnce(RETRIEVAL_RESULT);
    global.fetch.mockRejectedValue(new Error('Groq is down'));

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

describe('buildPrompt for curricula without their own books here', () => {
  const base = { curriculum: 'IB MYP', grade: '6', subject: 'Mathematics', topic: 'Integers', primaryText: 'x', contextText: '', contentType: 'mathematics' };
  test('never names another curriculum, book, chapter, page or figure', () => {
    const prompt = buildPrompt({ ...base, neutralSource: true });
    expect(prompt).toContain('This lesson is for a IB MYP class');
    expect(prompt).toMatch(/NEVER mention any textbook, book series, chapter, page or figure number, or another curriculum/);
  });
  test("the teacher's subtopics must all be taught, at the student's reading level", () => {
    const prompt = buildPrompt({ ...base, neutralSource: true, mustCover: ['Integers', 'primes'] });
    expect(prompt).toContain(`THE TEACHER'S SYLLABUS FOR THIS TOPIC: "Integers", "primes"`);
    expect(prompt).toMatch(/Teach EVERY one of these/);
    expect(prompt).toMatch(/Ignore any part of the source that is about a different topic/);
    expect(prompt).toMatch(/short sentences \(mostly under 15 words\)/);
  });
  test('CBSE prompts are unchanged', () => {
    expect(buildPrompt({ ...base, curriculum: 'CBSE' })).not.toContain('NEVER mention any textbook');
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

  test('generates content via the shared LLM_CHAIN on success', async () => {
    groqReturns(VALID_PAYLOAD);

    const result = await generateStructuredContent(knowledgeInput);

    expect(result.ok).toBe(true);
    expect(global.fetch).toHaveBeenCalledTimes(1);
  });

  test('a rate-limited first attempt retries once and still succeeds', async () => {
    fetchErr(429, 'rate limited');
    groqReturns(VALID_PAYLOAD);

    const result = await generateStructuredContent(knowledgeInput);

    expect(result.ok).toBe(true);
    expect(global.fetch).toHaveBeenCalledTimes(2);
  });

  test('{"unknown":true} short-circuits without a retry', async () => {
    groqReturns({ unknown: true });

    const result = await generateStructuredContent(knowledgeInput);

    expect(result.ok).toBe(false);
    expect(result.unknown).toBe(true);
    expect(global.fetch).toHaveBeenCalledTimes(1);
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
    expect(global.fetch).toHaveBeenCalledTimes(2);
  });

  test('a still-incomplete regeneration falls back to the first valid result rather than failing', async () => {
    const incomplete = { whatYoullLearn: ['x'], blocks: [{ type: 'explanation', text: 'x' }] };
    groqReturns(incomplete);
    groqReturns(incomplete);

    const result = await generateStructuredContent(groundedInput);

    expect(result.ok).toBe(true);
    expect(result.blocks).toHaveLength(1);
    expect(global.fetch).toHaveBeenCalledTimes(2);
  });
});

describe('buildKnowledgePrompt — anchoring without a confirmed chapter match', () => {
  test('no chapterMatched: anchors on curriculum/grade/subject/unit/topic/subtopics, and only bails on unintelligible topics', () => {
    const prompt = buildPrompt({
      mode: 'knowledge', curriculum: 'CBSE', grade: '6', subject: 'Mathematics',
      chapterTitle: 'Whole Numbers', chapterMatched: false, unitTitle: 'Whole Numbers',
      topic: 'Whole Numbers', subtopics: ['Number line', 'Successor and predecessor'], contentType: 'mathematics',
    });
    expect(prompt).toContain('Teach this topic as appropriate for CBSE Grade 6 Mathematics');
    expect(prompt).toContain('Number line; Successor and predecessor');
    expect(prompt).toContain('not intelligible or not a real school topic');
    expect(prompt).not.toContain('If you are not confident that "Whole Numbers" genuinely belongs to the chapter');
  });

  test('chapterMatched: keeps the stricter chapter-anchored wording', () => {
    const prompt = buildPrompt({
      mode: 'knowledge', curriculum: 'CBSE', grade: '6', subject: 'Mathematics',
      chapterTitle: 'Fractions', chapterMatched: true, topic: 'Understanding Fractions', contentType: 'mathematics',
    });
    expect(prompt).toContain('Stay strictly within that chapter\'s syllabus');
    expect(prompt).toContain('If you are not confident that "Understanding Fractions" genuinely belongs to the chapter "Fractions"');
  });
});
