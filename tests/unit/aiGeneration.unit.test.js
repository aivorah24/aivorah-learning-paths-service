// callGroq now runs through services/llm/fallback.js's callWithFallback
// (native fetch) instead of groq-sdk. This shim keeps every existing
// mockCreate.mockResolvedValueOnce(completionWith(...))-style test body
// working unchanged: fetch is mocked to forward each request into
// mockCreate and translate its return value/rejection back into a
// fetch Response (or a rejected fetch call, for a provider-level failure).
process.env.LLM_CHAIN = 'groq:openai/gpt-oss-120b,groq:openai/gpt-oss-20b';
process.env.GROQ_API_KEY = 'test-groq-key';
const { resetFallbackState } = require('../../services/llm/fallback');

const mockCreate = jest.fn();
global.fetch = jest.fn(async (url, req) => {
  const body = JSON.parse(req.body);
  const result = await mockCreate({ model: body.model, messages: body.messages, response_format: body.response_format, temperature: body.temperature });
  const content = result?.choices?.[0]?.message?.content;
  return { ok: true, json: async () => ({ choices: [{ message: { content } }] }) };
});

beforeEach(() => resetFallbackState());

const mockRetrieveGroundingContext = jest.fn();
jest.mock('../../services/curriculumUpload/groundedContent', () => ({
  retrieveGroundingContext: (...args) => mockRetrieveGroundingContext(...args),
}));

const mockGenerateStructuredContent = jest.fn();
jest.mock('../../services/curriculum/enrichment', () => ({
  generateStructuredContent: (...args) => mockGenerateStructuredContent(...args),
  classifyContentType: (subject) => (String(subject).toLowerCase() === 'mathematics' ? 'mathematics' : 'theory'),
}));

const mockFindTopicImages = jest.fn().mockResolvedValue([]);
jest.mock('../../services/qdrant', () => ({
  findTopicImages: (...args) => mockFindTopicImages(...args),
}));

const mockCheckGradeFit = jest.fn().mockResolvedValue({ quality: { readingGrade: 5, sentenceLength: 10, judgeScores: null, issues: [] }, failed: false });
jest.mock('../../services/curriculum/gradeFit', () => ({
  checkGradeFit: (...args) => mockCheckGradeFit(...args),
}));

// Shared topic cache: default to always-miss/no-op so existing generation
// tests are unaffected — tests/unit/topicCache.unit.test.js and the
// "shared topic cache" describe block below cover its own behaviour.
const mockGetCachedTopic = jest.fn().mockResolvedValue(null);
const mockPersistCachedTopic = jest.fn().mockResolvedValue(undefined);
const mockDedupeGeneration = jest.fn((key, fn) => fn());
jest.mock('../../services/curriculumUpload/topicCache', () => ({
  buildCacheKey: (metadata, ref) => `${metadata?.curriculum}|${metadata?.grade}|${metadata?.subject}|${ref.topicTitle}`,
  getCachedTopic: (...args) => mockGetCachedTopic(...args),
  persistCachedTopic: (...args) => mockPersistCachedTopic(...args),
  dedupeGeneration: (...args) => mockDedupeGeneration(...args),
}));

const {
  generateLearningPathDraft,
  collectTopicRefs,
  validateGeneratedTopics,
  mergeGeneratedContent,
  deriveObjectivesAndLessons,
  generateWorkedExample,
  generateCompanions,
  matchChapter,
  LearningPathGenerationError,
} = require('../../services/curriculumUpload/aiGeneration');

function completionWith(content) {
  return { choices: [{ message: { content: JSON.stringify(content) } }] };
}

const normalized = {
  sourceFormat: 'pdf',
  unstructured: false,
  metadata: { grade: '6', subject: 'Mathematics' },
  units: [
    {
      title: 'Numbers',
      order: 0,
      topics: [
        { title: 'Whole Numbers', order: 0, subtopics: [{ title: 'Addition', order: 0 }], content: ['Covers place value and number lines.'] },
        { title: 'Fractions', order: 1, subtopics: [], content: [] },
      ],
    },
  ],
};

describe('collectTopicRefs', () => {
  test('flattens titled topics with their unit/topic order, subtopic titles and source context', () => {
    expect(collectTopicRefs(normalized)).toEqual([
      { unitOrder: 0, topicOrder: 0, unitTitle: 'Numbers', topicTitle: 'Whole Numbers', subtopics: ['Addition'], sourceContext: 'Covers place value and number lines.' },
      { unitOrder: 0, topicOrder: 1, unitTitle: 'Numbers', topicTitle: 'Fractions', subtopics: [], sourceContext: '' },
    ]);
  });

  test('skips untitled topics', () => {
    const withUntitled = { units: [{ order: 0, title: 'U', topics: [{ order: 0, title: null, subtopics: [] }] }] };
    expect(collectTopicRefs(withUntitled)).toEqual([]);
  });

  test('caps very long source context so the prompt stays bounded', () => {
    const long = { units: [{ order: 0, title: 'U', topics: [{ order: 0, title: 'T', subtopics: [], content: ['x'.repeat(5000)] }] }] };
    expect(collectTopicRefs(long)[0].sourceContext.length).toBe(1500);
  });
});

describe('deriveObjectivesAndLessons', () => {
  test('maps a worked_example block into a lesson with the real worked steps and final answer', () => {
    const { lessons } = deriveObjectivesAndLessons(['Add whole numbers'], [
      { type: 'worked_example', concept: 'Addition', problem: '245 + 378 = ?', steps: [{ step: 1, action: 'Add ones: 5+8=13, write 3 carry 1', why: 'ones place first' }], finalAnswer: '623' },
    ]);
    expect(lessons[0].title).toBe('Addition');
    expect(lessons[0].summary).toContain('245 + 378 = ?');
    expect(lessons[0].summary).toContain('Add ones: 5+8=13');
    expect(lessons[0].summary).toContain('623');
  });

  test('numbers multi-step worked examples with real line breaks instead of a run-on sentence', () => {
    const { lessons } = deriveObjectivesAndLessons([], [
      {
        type: 'worked_example', concept: 'Fractions', problem: 'Compare 5/8 and 3/5',
        steps: [
          { step: 1, action: 'Divide 5 by 8', equation: '5 ÷ 8 = 0.625', why: 'convert to decimal' },
          { step: 2, action: 'Divide 3 by 5', equation: '3 ÷ 5 = 0.6', why: 'convert to decimal' },
        ],
        finalAnswer: '5/8 is greater',
      },
    ]);
    expect(lessons[0].summary).toBe(
      'Compare 5/8 and 3/5\n1. Divide 5 by 8 (5 ÷ 8 = 0.625)\n2. Divide 3 by 5 (3 ÷ 5 = 0.6)\nFinal answer: 5/8 is greater'
    );
  });

  test('falls back to the explanation block when no example-shaped block exists', () => {
    const { lessons } = deriveObjectivesAndLessons([], [{ type: 'explanation', text: 'Whole numbers start from 0.' }]);
    expect(lessons).toEqual([{ title: 'Explanation', summary: 'Whole numbers start from 0.' }]);
  });

  test('produces no lessons when blocks are empty', () => {
    expect(deriveObjectivesAndLessons(['x'], []).lessons).toEqual([]);
  });
});

describe('validateGeneratedTopics', () => {
  const refs = [{ unitOrder: 0, topicOrder: 0 }, { unitOrder: 0, topicOrder: 1 }];

  test('accepts a well-formed response matching known topics', () => {
    const result = validateGeneratedTopics({
      topics: [{ unitOrder: 0, topicOrder: 0, objectives: ['Add two numbers'], lessons: [{ title: 'Intro', summary: 'x' }] }],
    }, refs);
    expect(result.valid).toBe(true);
    expect(result.topics).toEqual([{ unitOrder: 0, topicOrder: 0, objectives: ['Add two numbers'], lessons: [{ title: 'Intro', summary: 'x' }], status: 'ready', teacherHint: null, groundingSource: 'upload_text_only' }]);
  });

  test('carries needs_teacher_input status and teacherHint through when the model flags a gap', () => {
    const result = validateGeneratedTopics({
      topics: [{
        unitOrder: 0, topicOrder: 0, status: 'needs_teacher_input',
        teacherHint: 'The uploaded document lists this topic with no subtopics — specify scope.',
        objectives: [], lessons: [],
      }],
    }, refs);
    expect(result.valid).toBe(true);
    expect(result.topics[0].status).toBe('needs_teacher_input');
    expect(result.topics[0].teacherHint).toBe('The uploaded document lists this topic with no subtopics — specify scope.');
  });

  test('ignores a teacherHint when status is not needs_teacher_input', () => {
    const result = validateGeneratedTopics({
      topics: [{ unitOrder: 0, topicOrder: 0, status: 'ready', teacherHint: 'should be dropped', objectives: ['x'], lessons: [] }],
    }, refs);
    expect(result.topics[0].teacherHint).toBeNull();
  });

  test('drops an entry referencing an unknown unitOrder/topicOrder rather than merging it', () => {
    const result = validateGeneratedTopics({
      topics: [{ unitOrder: 9, topicOrder: 9, objectives: [], lessons: [] }],
    }, refs);
    expect(result.valid).toBe(false);
    expect(result.errors[0]).toMatch(/unknown topic/);
  });

  test('rejects a response with no topics array', () => {
    expect(validateGeneratedTopics({}, refs).valid).toBe(false);
    expect(validateGeneratedTopics(null, refs).valid).toBe(false);
  });

  test('rejects a response where every entry is invalid', () => {
    const result = validateGeneratedTopics({ topics: [{ objectives: [] }] }, refs);
    expect(result.valid).toBe(false);
  });
});

describe('mergeGeneratedContent', () => {
  test('preserves curriculum hierarchy/ordering and attaches AI content only to matching topics', () => {
    const merged = mergeGeneratedContent(normalized, [
      { unitOrder: 0, topicOrder: 0, objectives: ['Add numbers'], lessons: [{ title: 'Intro', summary: 's' }] },
    ]);

    expect(merged.units[0].title).toBe('Numbers');
    expect(merged.units[0].topics[0].objectives).toEqual(['Add numbers']);
    expect(merged.units[0].topics[1].objectives).toEqual([]);
    expect(merged.units[0].topics[0].subtopics).toEqual([{ title: 'Addition', order: 0 }]);
  });

  test('carries the normalized metadata through onto the merged content', () => {
    const merged = mergeGeneratedContent(normalized, []);
    expect(merged.metadata).toEqual({ grade: '6', subject: 'Mathematics' });
  });

  test('defaults metadata to an empty object when the normalized structure has none', () => {
    const merged = mergeGeneratedContent({ units: [] }, []);
    expect(merged.metadata).toEqual({});
  });

  test('carries content and groundingSource through, defaulting to none when absent', () => {
    const merged = mergeGeneratedContent(normalized, [
      { unitOrder: 0, topicOrder: 0, objectives: [], lessons: [], content: { whatYoullLearn: ['x'], blocks: [] }, groundingSource: 'ncert_vector' },
    ]);
    expect(merged.units[0].topics[0].groundingSource).toBe('ncert_vector');
    expect(merged.units[0].topics[0].content).toEqual({ whatYoullLearn: ['x'], blocks: [] });
    expect(merged.units[0].topics[1].groundingSource).toBe('none');
    expect(merged.units[0].topics[1].content).toBeNull();
  });
});

describe('generateWorkedExample', () => {
  beforeEach(() => jest.clearAllMocks());

  const topicRef = { topicTitle: 'Adding Fractions', unitOrder: 0, topicOrder: 0 };
  const metadata = { grade: '6', subject: 'Mathematics' };

  test('grounds the prompt in the retrieved source text and the topic title', async () => {
    mockCreate.mockResolvedValueOnce(completionWith({
      type: 'worked_example',
      problem: '1/4 + 1/2 = ?',
      concept: 'Adding unlike fractions',
      steps: [{ step: 1, action: 'Convert to a common denominator: 1/4 + 2/4', why: 'fractions need the same denominator to add' }],
      finalAnswer: '3/4',
    }));

    const block = await generateWorkedExample(topicRef, metadata, "Brahmagupta's method involves finding a common denominator.");

    expect(block.type).toBe('worked_example');
    expect(block.finalAnswer).toBe('3/4');
    const sentPrompt = mockCreate.mock.calls[0][0].messages[0].content;
    expect(sentPrompt).toContain('Adding Fractions');
    expect(sentPrompt).toContain("Brahmagupta's method");
  });

  test('returns null when the model response fails block validation', async () => {
    mockCreate.mockResolvedValueOnce(completionWith({ type: 'worked_example', problem: 'x' })); // missing steps/finalAnswer
    const block = await generateWorkedExample(topicRef, metadata, 'source text');
    expect(block).toBeNull();
  });

  test('returns null on invalid JSON rather than throwing', async () => {
    mockCreate.mockResolvedValueOnce({ choices: [{ message: { content: 'not json' } }] });
    const block = await generateWorkedExample(topicRef, metadata, 'source text');
    expect(block).toBeNull();
  });

  test('returns null when the Groq call itself fails, never throwing', async () => {
    mockCreate.mockRejectedValue(new Error('rate limited'));
    const block = await generateWorkedExample(topicRef, metadata, 'source text');
    expect(block).toBeNull();
  });

  // Hallucination-disclosure fix: the source has no worked problem to draw
  // numbers from, so any worked example this function produces must be
  // tagged synthetic — never presented as if it were NCERT-sourced.
  test('always tags a successfully generated worked example as synthetic, regardless of what the model returns', async () => {
    mockCreate.mockResolvedValueOnce(completionWith({
      type: 'worked_example',
      problem: '1/4 + 1/2 = ?',
      concept: 'Adding unlike fractions',
      steps: [{ step: 1, action: 'Convert to a common denominator: 1/4 + 2/4', why: 'fractions need the same denominator to add' }],
      finalAnswer: '3/4',
      // A model that ignores the instruction and claims groundedness must
      // not be able to unset the disclosure flag — it's applied by the
      // caller, not requested of the model.
      synthetic: false,
    }));

    const block = await generateWorkedExample(topicRef, metadata, 'source text');

    expect(block.synthetic).toBe(true);
  });

  test('prompt tells the model the numbers are not from the source material', async () => {
    mockCreate.mockResolvedValueOnce(completionWith({
      type: 'worked_example', problem: 'x', steps: [{ step: 1, action: 'a', why: 'b' }], finalAnswer: 'y',
    }));

    await generateWorkedExample(topicRef, metadata, 'source text');

    const sentPrompt = mockCreate.mock.calls[0][0].messages[0].content;
    expect(sentPrompt).toMatch(/not taken from the source material/i);
  });
});

describe('generateLearningPathDraft — NCERT/vector grounding', () => {
  beforeEach(() => jest.clearAllMocks());

  test('uses real retrieved content for a topic with a genuine vector match, skipping the batch Groq call for it', async () => {
    mockRetrieveGroundingContext.mockImplementation(async ({ topic }) =>
      topic === 'Whole Numbers' ? { context: 'Real NCERT text about whole numbers and the number line.', meta: { selected: 2 } } : null
    );
    mockGenerateStructuredContent.mockResolvedValueOnce({
      ok: true,
      whatYoullLearn: ['Place whole numbers on a number line'],
      blocks: [{ type: 'worked_example', concept: 'Number line', problem: 'Plot 7 on a number line', steps: [{ step: 1, action: 'Mark 0 to 10', why: 'establishes scale' }], finalAnswer: '7 marked between 6 and 8' }],
    });
    // Whole Numbers (grounded) also gets a generateCompanions call — route
    // mockCreate by prompt content so it doesn't consume the batch's once-value.
    mockCreate.mockImplementation(async (opts) => {
      const prompt = opts.messages[0].content;
      if (prompt.includes('audio script')) return completionWith({ listenParts: [], questions: [] });
      return completionWith({ topics: [{ unitOrder: 0, topicOrder: 1, objectives: [], lessons: [] }] });
    });

    const draft = await generateLearningPathDraft(normalized);

    expect(mockGenerateStructuredContent).toHaveBeenCalledWith(expect.objectContaining({
      primaryText: 'Real NCERT text about whole numbers and the number line.',
      topic: 'Whole Numbers',
      grade: '6',
      subject: 'Mathematics',
    }));
    const wholeNumbers = draft.units[0].topics[0];
    expect(wholeNumbers.groundingSource).toBe('ncert_vector');
    expect(wholeNumbers.lessons[0].summary).toContain('Plot 7 on a number line');
    expect(wholeNumbers.objectives).toEqual(['Place whole numbers on a number line']);

    // Only the ungrounded topic (Fractions) went through the batch Groq prompt.
    const batchCall = mockCreate.mock.calls.find((c) => !c[0].messages[0].content.includes('audio script'));
    expect(batchCall[0].messages[0].content).not.toContain('Whole Numbers');
    expect(batchCall[0].messages[0].content).toContain('Fractions');
  });

  test('falls back to upload-text grounding when retrieval AND model knowledge both find nothing', async () => {
    mockRetrieveGroundingContext.mockResolvedValue(null);
    mockGenerateStructuredContent.mockResolvedValue({ ok: false, unknown: true, reason: 'unknown' });
    mockCreate.mockResolvedValueOnce(completionWith({
      topics: [
        { unitOrder: 0, topicOrder: 0, objectives: ['x'], lessons: [] },
        { unitOrder: 0, topicOrder: 1, objectives: [], lessons: [] },
      ],
    }));

    const draft = await generateLearningPathDraft(normalized);

    expect(mockGenerateStructuredContent).toHaveBeenCalledWith(expect.objectContaining({ mode: 'knowledge' }));
    expect(draft.units[0].topics[0].groundingSource).toBe('upload_text_only');
  });

  test('does not cross-contaminate: a retrieval hit for one topic is never applied to another', async () => {
    mockRetrieveGroundingContext.mockImplementation(async ({ topic }) =>
      topic === 'Fractions' ? { context: 'Real NCERT fractions text.', meta: { selected: 1 } } : null
    );
    mockGenerateStructuredContent.mockResolvedValueOnce({ ok: true, whatYoullLearn: [], blocks: [{ type: 'explanation', text: 'Fractions explained.' }] });
    // Fractions' blocks have no worked_example and the subject is Mathematics, so the
    // extra targeted worked-example call fires too — route mockCreate by prompt content
    // instead of call order since it now fires concurrently with the batch call.
    mockCreate.mockImplementation(async (opts) => {
      const prompt = opts.messages[0].content;
      if (prompt.includes('worked mathematical example')) return completionWith({ topics: [] }); // invalid worked_example shape -> skipped
      return completionWith({ topics: [{ unitOrder: 0, topicOrder: 0, objectives: [], lessons: [] }] });
    });

    const draft = await generateLearningPathDraft(normalized);

    expect(draft.units[0].topics[0].groundingSource).toBe('upload_text_only'); // Whole Numbers
    expect(draft.units[0].topics[1].groundingSource).toBe('ncert_vector'); // Fractions
    expect(draft.units[0].topics[1].lessons[0].summary).toBe('Fractions explained.');
  });

  test('a grounded generation failure for one topic still falls back to the batch path for it', async () => {
    mockRetrieveGroundingContext.mockResolvedValue({ context: 'text', meta: { selected: 1 } });
    mockGenerateStructuredContent.mockResolvedValue({ ok: false, reason: 'schema_validation_failed' });
    mockCreate.mockResolvedValueOnce(completionWith({
      topics: [
        { unitOrder: 0, topicOrder: 0, objectives: ['fallback'], lessons: [] },
        { unitOrder: 0, topicOrder: 1, objectives: [], lessons: [] },
      ],
    }));

    const draft = await generateLearningPathDraft(normalized);

    expect(draft.units[0].topics[0].groundingSource).toBe('upload_text_only');
    expect(draft.units[0].topics[0].objectives).toEqual(['fallback']);
  });
});

describe('generateLearningPathDraft — knowledge tier (model_knowledge)', () => {
  beforeEach(() => jest.clearAllMocks());

  test('an ungrounded topic gets tagged model_knowledge when the knowledge LLM succeeds', async () => {
    mockRetrieveGroundingContext.mockResolvedValue(null);
    mockGenerateStructuredContent.mockImplementation(async ({ topic }) =>
      topic === 'Whole Numbers'
        ? { ok: true, whatYoullLearn: ['Understand whole numbers'], blocks: [{ type: 'explanation', text: 'Whole numbers explained.' }] }
        : { ok: false, unknown: true, reason: 'unknown' }
    );
    // Whole Numbers is Mathematics with no worked_example block, so
    // finalizeGeneratedTopic also fires the targeted worked-example call —
    // route mockCreate by prompt content so both calls resolve correctly.
    mockCreate.mockImplementation(async (opts) => {
      const prompt = opts.messages[0].content;
      if (prompt.includes('worked mathematical')) return completionWith({ topics: [] }); // invalid shape -> skipped
      return completionWith({ topics: [{ unitOrder: 0, topicOrder: 1, objectives: [], lessons: [] }] });
    });

    const draft = await generateLearningPathDraft(normalized);

    const wholeNumbers = draft.units[0].topics[0];
    expect(wholeNumbers.groundingSource).toBe('model_knowledge');
    expect(wholeNumbers.status).toBe('ready');
    expect(wholeNumbers.content.blocks.some((b) => b.type === 'explanation')).toBe(true);
    expect(draft.units[0].topics[1].groundingSource).toBe('upload_text_only'); // Fractions, unknown:true
  });

  test('a knowledge-tier worked_example is always tagged GROUNDED_SYNTHETIC/synthetic, never SOURCE_DERIVED', async () => {
    mockRetrieveGroundingContext.mockResolvedValue(null);
    mockGenerateStructuredContent.mockImplementation(async ({ topic }) =>
      topic === 'Whole Numbers'
        ? {
            ok: true, whatYoullLearn: ['x'],
            blocks: [{ type: 'worked_example', concept: 'c', problem: 'p', steps: [{ step: 1, action: 'a', why: 'b' }], finalAnswer: 'x' }],
          }
        : { ok: false, unknown: true, reason: 'unknown' }
    );
    mockCreate.mockResolvedValue(completionWith({ topics: [{ unitOrder: 0, topicOrder: 1, objectives: [], lessons: [] }] }));

    const draft = await generateLearningPathDraft(normalized);

    const block = draft.units[0].topics[0].content.blocks.find((b) => b.type === 'worked_example');
    expect(block.exampleType).toBe('GROUNDED_SYNTHETIC');
    expect(block.synthetic).toBe(true);
  });
});

describe('groundTopic — worked-example disclosure', () => {
  beforeEach(() => jest.clearAllMocks());

  const singleTopicNormalized = {
    metadata: { grade: '6', subject: 'Mathematics' },
    units: [{ title: 'Numbers', order: 0, topics: [
      { title: 'Whole Numbers', order: 0, subtopics: [], content: [] },
    ] }],
  };

  test('source already has a worked example: used as-is, no extra Groq call, not marked synthetic', async () => {
    mockRetrieveGroundingContext.mockResolvedValue({ context: 'Real NCERT text with a worked problem in it.', meta: { selected: 1 } });
    mockGenerateStructuredContent.mockResolvedValueOnce({
      ok: true,
      whatYoullLearn: ['Add whole numbers'],
      blocks: [{
        type: 'worked_example', concept: 'Addition', problem: '245 + 378 = ?',
        steps: [{ step: 1, action: 'Add ones', why: 'ones place first' }], finalAnswer: '623',
      }],
    });

    const draft = await generateLearningPathDraft(singleTopicNormalized);

    // Only the generateCompanions call fires — no targeted generateWorkedExample call needed.
    expect(mockCreate).toHaveBeenCalledTimes(1);
    const block = draft.units[0].topics[0].content.blocks.find((b) => b.type === 'worked_example');
    expect(block.synthetic).toBeUndefined();
    expect(block.finalAnswer).toBe('623');
  });

  test('source has no worked example: the synthesized one is tagged synthetic, never presented as textbook content', async () => {
    mockRetrieveGroundingContext.mockResolvedValue({ context: 'NCERT text describing the method only, no worked problem.', meta: { selected: 1 } });
    mockGenerateStructuredContent.mockResolvedValueOnce({
      ok: true,
      whatYoullLearn: ['Understand place value'],
      blocks: [{ type: 'explanation', text: 'Place value explanation.' }],
    });
    mockCreate.mockResolvedValueOnce(completionWith({
      type: 'worked_example', problem: '245 + 378 = ?', concept: 'Addition',
      steps: [{ step: 1, action: 'Add ones', why: 'ones place first' }], finalAnswer: '623',
    }));

    const draft = await generateLearningPathDraft(singleTopicNormalized);

    const block = draft.units[0].topics[0].content.blocks.find((b) => b.type === 'worked_example');
    expect(block.synthetic).toBe(true);
    // still status "ready" and still ncert_vector-grounded overall — only the
    // one supplementary block is disclosed as synthetic, per the smallest-fix
    // scope (the rest of the topic's content is genuinely grounded).
    expect(draft.units[0].topics[0].status).toBe('ready');
    expect(draft.units[0].topics[0].groundingSource).toBe('ncert_vector');
  });

  test('source has no worked example and the targeted Groq call also fails: topic still has real grounded content, no fabricated example, no crash', async () => {
    mockRetrieveGroundingContext.mockResolvedValue({ context: 'NCERT text, method only.', meta: { selected: 1 } });
    mockGenerateStructuredContent.mockResolvedValueOnce({
      ok: true,
      whatYoullLearn: ['Understand place value'],
      blocks: [{ type: 'explanation', text: 'Place value explanation.' }],
    });
    mockCreate.mockRejectedValue(new Error('rate limited'));

    const draft = await generateLearningPathDraft(singleTopicNormalized);

    const blocks = draft.units[0].topics[0].content.blocks;
    expect(blocks.some((b) => b.type === 'worked_example')).toBe(false);
    expect(blocks.some((b) => b.type === 'explanation')).toBe(true);
  });

  test('insufficient grounding AND unconfident model knowledge falls through to needs_teacher_input, never fabricates', async () => {
    mockRetrieveGroundingContext.mockResolvedValue(null);
    mockGenerateStructuredContent.mockResolvedValue({ ok: false, unknown: true, reason: 'unknown' });
    mockCreate.mockResolvedValueOnce(completionWith({
      topics: [{ unitOrder: 0, topicOrder: 0, status: 'needs_teacher_input', teacherHint: 'Add topic detail.', objectives: [], lessons: [] }],
    }));

    const draft = await generateLearningPathDraft(singleTopicNormalized);

    expect(mockGenerateStructuredContent).toHaveBeenCalledWith(expect.objectContaining({ mode: 'knowledge' }));
    expect(draft.units[0].topics[0].status).toBe('needs_teacher_input');
    expect(draft.units[0].topics[0].content).toBeNull();
  });
});

describe('groundTopic — SOURCE_DERIVED/GROUNDED_SYNTHETIC taxonomy and image passthrough', () => {
  beforeEach(() => jest.clearAllMocks());

  const singleTopicNormalized = {
    metadata: { grade: '6', subject: 'Mathematics' },
    units: [{ title: 'Numbers', order: 0, topics: [
      { title: 'Whole Numbers', order: 0, subtopics: [], content: [] },
    ] }],
  };

  test('a real source-grounded worked_example is tagged SOURCE_DERIVED', async () => {
    mockRetrieveGroundingContext.mockResolvedValue({ context: 'Real NCERT text with a worked problem in it.', meta: { selected: 1 } });
    mockGenerateStructuredContent.mockResolvedValueOnce({
      ok: true,
      whatYoullLearn: ['Add whole numbers'],
      blocks: [{
        type: 'worked_example', concept: 'Addition', problem: '245 + 378 = ?',
        steps: [{ step: 1, action: 'Add ones', why: 'ones place first' }], finalAnswer: '623',
      }],
    });

    const draft = await generateLearningPathDraft(singleTopicNormalized);

    const block = draft.units[0].topics[0].content.blocks.find((b) => b.type === 'worked_example');
    expect(block.exampleType).toBe('SOURCE_DERIVED');
  });

  test('a synthesized worked_example with correct arithmetic is tagged GROUNDED_SYNTHETIC and synthetic:true', async () => {
    mockRetrieveGroundingContext.mockResolvedValue({ context: 'NCERT text describing the method only.', meta: { selected: 1 } });
    mockGenerateStructuredContent.mockResolvedValueOnce({
      ok: true,
      whatYoullLearn: ['Understand place value'],
      blocks: [{ type: 'explanation', text: 'Place value explanation.' }],
    });
    mockCreate.mockResolvedValueOnce(completionWith({
      type: 'worked_example', problem: '12 + 8 = ?', concept: 'Addition',
      steps: [{ step_number: 1, explanation: 'Add the numbers', calculation: '12 + 8 = 20' }], finalAnswer: '20',
    }));

    const draft = await generateLearningPathDraft(singleTopicNormalized);

    const block = draft.units[0].topics[0].content.blocks.find((b) => b.type === 'worked_example');
    expect(block.exampleType).toBe('GROUNDED_SYNTHETIC');
    expect(block.synthetic).toBe(true);
  });

  test('a retrieved image is attached as a real "image" block', async () => {
    mockRetrieveGroundingContext.mockResolvedValue({ context: 'text', meta: { selected: 1 } });
    mockFindTopicImages.mockResolvedValueOnce([{ url: 'https://cdn/x.png', caption: 'A number line diagram' }]);
    mockGenerateStructuredContent.mockResolvedValueOnce({
      ok: true, whatYoullLearn: ['x'], blocks: [{ type: 'explanation', text: 'x' }],
    });
    mockCreate.mockResolvedValueOnce(completionWith({
      type: 'worked_example', problem: '1 + 1 = ?',
      steps: [{ step_number: 1, explanation: 'add', calculation: '1 + 1 = 2' }], finalAnswer: '2',
    }));

    const draft = await generateLearningPathDraft(singleTopicNormalized);

    const imageBlock = draft.units[0].topics[0].content.blocks.find((b) => b.type === 'image');
    expect(imageBlock).toEqual({ type: 'image', url: 'https://cdn/x.png', caption: 'A number line diagram', alt_text: 'A number line diagram' });
  });

  test('no retrieved image means no image block is invented', async () => {
    mockRetrieveGroundingContext.mockResolvedValue({ context: 'text', meta: { selected: 1 }, images: [] });
    mockGenerateStructuredContent.mockResolvedValueOnce({
      ok: true, whatYoullLearn: ['x'], blocks: [{ type: 'explanation', text: 'x' }],
    });
    mockCreate.mockResolvedValueOnce(completionWith({
      type: 'worked_example', problem: '1 + 1 = ?',
      steps: [{ step_number: 1, explanation: 'add', calculation: '1 + 1 = 2' }], finalAnswer: '2',
    }));

    const draft = await generateLearningPathDraft(singleTopicNormalized);

    expect(draft.units[0].topics[0].content.blocks.some((b) => b.type === 'image')).toBe(false);
  });
});

describe('generateWorkedExample — deterministic arithmetic verification', () => {
  beforeEach(() => jest.clearAllMocks());
  const topicRef = { topicTitle: 'Adding Numbers', unitOrder: 0, topicOrder: 0 };
  const metadata = { grade: '6', subject: 'Mathematics' };

  test('correct arithmetic on the first attempt: one Groq call, tagged GROUNDED_SYNTHETIC', async () => {
    mockCreate.mockResolvedValueOnce(completionWith({
      type: 'worked_example', problem: '12 + 8 = ?',
      steps: [{ step_number: 1, explanation: 'Add', calculation: '12 + 8 = 20' }], finalAnswer: '20',
    }));

    const block = await generateWorkedExample(topicRef, metadata, 'source text');

    expect(mockCreate).toHaveBeenCalledTimes(1);
    expect(block.exampleType).toBe('GROUNDED_SYNTHETIC');
    expect(block.synthetic).toBe(true);
  });

  test('wrong arithmetic on attempt 1, correct on retry: two Groq calls, still returns a verified block', async () => {
    mockCreate
      .mockResolvedValueOnce(completionWith({
        type: 'worked_example', problem: '12 + 8 = ?',
        steps: [{ step_number: 1, explanation: 'Add', calculation: '12 + 8 = 21' }], finalAnswer: '21',
      }))
      .mockResolvedValueOnce(completionWith({
        type: 'worked_example', problem: '12 + 8 = ?',
        steps: [{ step_number: 1, explanation: 'Add', calculation: '12 + 8 = 20' }], finalAnswer: '20',
      }));

    const block = await generateWorkedExample(topicRef, metadata, 'source text');

    expect(mockCreate).toHaveBeenCalledTimes(2);
    expect(block.finalAnswer).toBe('20');
    // the retry prompt must mention the specific failure so the model can fix it
    const retryPrompt = mockCreate.mock.calls[1][0].messages[0].content;
    expect(retryPrompt).toMatch(/incorrect arithmetic/i);
  });

  test('wrong arithmetic on both attempts: never returned, never silently accepted', async () => {
    mockCreate.mockResolvedValue(completionWith({
      type: 'worked_example', problem: '12 + 8 = ?',
      steps: [{ step_number: 1, explanation: 'Add', calculation: '12 + 8 = 21' }], finalAnswer: '21',
    }));

    const block = await generateWorkedExample(topicRef, metadata, 'source text');

    expect(mockCreate).toHaveBeenCalledTimes(2);
    expect(block).toBeNull();
  });

  test('legacy {action, why} step shape (no calculation field) is unverifiable, still accepted on first attempt', async () => {
    mockCreate.mockResolvedValueOnce(completionWith({
      type: 'worked_example', problem: '1/4 + 1/2 = ?',
      steps: [{ step: 1, action: 'Convert to common denominator', why: 'fractions need the same denominator' }],
      finalAnswer: '3/4',
    }));

    const block = await generateWorkedExample(topicRef, metadata, 'source text');

    expect(mockCreate).toHaveBeenCalledTimes(1);
    expect(block.exampleType).toBe('GROUNDED_SYNTHETIC');
  });
});

describe('generateLearningPathDraft — shared topic cache', () => {
  beforeEach(() => jest.clearAllMocks());
  // mockResolvedValue (not …Once) is used below for concurrency tests —
  // reset it so later describe blocks get their own fresh default behaviour.
  afterEach(() => {
    mockGenerateStructuredContent.mockReset();
    mockRetrieveGroundingContext.mockReset();
    mockCreate.mockReset();
  });

  const cacheTopicNormalized = {
    metadata: { curriculum: 'CBSE', grade: '6', subject: 'Mathematics' },
    units: [{ title: 'Numbers', order: 0, topics: [
      { title: 'Whole Numbers', order: 0, subtopics: [], content: [] },
    ] }],
  };
  const CACHED_PAYLOAD = {
    status: 'ready', groundingSource: 'ncert_vector', objectives: ['x'], lessons: [],
    content: { blocks: [{ type: 'explanation', text: 'cached' }] },
  };

  test('cache miss: generates normally and writes the ready result back', async () => {
    mockGetCachedTopic.mockResolvedValueOnce(null);
    mockRetrieveGroundingContext.mockResolvedValue({ context: 'Real NCERT text.', meta: { selected: 1 } });
    mockGenerateStructuredContent.mockResolvedValueOnce({ ok: true, whatYoullLearn: ['x'], blocks: [{ type: 'explanation', text: 'y' }] });

    const draft = await generateLearningPathDraft(cacheTopicNormalized);

    expect(draft.units[0].topics[0].content.blocks[0].text).toBe('y');
    expect(mockPersistCachedTopic).toHaveBeenCalledWith(expect.any(String), expect.objectContaining({
      topic: 'Whole Numbers',
      payload: expect.objectContaining({ status: 'ready' }),
    }));
  });

  test('cache hit: no LLM calls at all for that topic', async () => {
    mockGetCachedTopic.mockResolvedValueOnce(CACHED_PAYLOAD);

    const draft = await generateLearningPathDraft(cacheTopicNormalized);

    expect(draft.units[0].topics[0].content.blocks[0].text).toBe('cached');
    expect(mockRetrieveGroundingContext).not.toHaveBeenCalled();
    expect(mockGenerateStructuredContent).not.toHaveBeenCalled();
    expect(mockCreate).not.toHaveBeenCalled();
    expect(mockPersistCachedTopic).not.toHaveBeenCalled();
  });

  test('needs_teacher_input is never written to the cache', async () => {
    mockGetCachedTopic.mockResolvedValue(null);
    mockRetrieveGroundingContext.mockResolvedValue(null);
    mockGenerateStructuredContent.mockResolvedValue({ ok: false, unknown: true, reason: 'unknown' });
    mockCreate.mockResolvedValue(completionWith({ topics: [{ unitOrder: 0, topicOrder: 0, status: 'needs_teacher_input', teacherHint: 'x', objectives: [], lessons: [] }] }));

    await generateLearningPathDraft(cacheTopicNormalized);

    expect(mockPersistCachedTopic).not.toHaveBeenCalled();
  });

  test('a cache read error still falls through to generation, never breaks the draft', async () => {
    mockGetCachedTopic.mockRejectedValueOnce(new Error('supabase down'));
    mockRetrieveGroundingContext.mockResolvedValue({ context: 'Real NCERT text.', meta: { selected: 1 } });
    mockGenerateStructuredContent.mockResolvedValueOnce({ ok: true, whatYoullLearn: ['x'], blocks: [{ type: 'explanation', text: 'y' }] });

    const draft = await generateLearningPathDraft(cacheTopicNormalized);

    expect(draft.units[0].topics[0].content.blocks[0].text).toBe('y');
  });

  test('concurrent identical topics are deduped through dedupeGeneration', async () => {
    mockGetCachedTopic.mockResolvedValue(null);
    mockRetrieveGroundingContext.mockResolvedValue({ context: 'Real NCERT text.', meta: { selected: 1 } });
    mockGenerateStructuredContent.mockResolvedValue({ ok: true, whatYoullLearn: ['x'], blocks: [{ type: 'explanation', text: 'y' }] });

    await Promise.all([generateLearningPathDraft(cacheTopicNormalized), generateLearningPathDraft(cacheTopicNormalized)]);

    // dedupeGeneration was invoked once per draft's topic — the real
    // production implementation (tested separately) collapses these into
    // one in-flight generation when the same key is already running.
    expect(mockDedupeGeneration).toHaveBeenCalledTimes(2);
    expect(mockDedupeGeneration.mock.calls[0][0]).toBe(mockDedupeGeneration.mock.calls[1][0]);
  });
});

describe('generateLearningPathDraft', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockRetrieveGroundingContext.mockResolvedValue(null);
  });

  test('sends each topic\'s source text and curriculum metadata to Groq', async () => {
    mockCreate.mockResolvedValueOnce(completionWith({
      topics: [{ unitOrder: 0, topicOrder: 0, objectives: [], lessons: [] }, { unitOrder: 0, topicOrder: 1, objectives: [], lessons: [] }],
    }));

    await generateLearningPathDraft(normalized);

    const sentPrompt = mockCreate.mock.calls[0][0].messages[0].content;
    expect(sentPrompt).toContain('Covers place value and number lines.');
    expect(sentPrompt).toContain('Grade 6');
    expect(sentPrompt).toContain('Mathematics');
    expect(sentPrompt).toMatch(/ground/i);
  });

  test('returns a valid draft on the first successful Groq response', async () => {
    mockCreate.mockResolvedValueOnce(completionWith({
      topics: [{ unitOrder: 0, topicOrder: 0, objectives: ['Add numbers'], lessons: [] }, { unitOrder: 0, topicOrder: 1, objectives: [], lessons: [] }],
    }));

    const draft = await generateLearningPathDraft(normalized);

    expect(draft.units[0].topics[0].objectives).toEqual(['Add numbers']);
    expect(mockCreate).toHaveBeenCalledTimes(1);
  });

  test('skips calling Groq entirely for a fully unstructured curriculum', async () => {
    const empty = { units: [{ order: 0, title: null, topics: [] }] };
    const draft = await generateLearningPathDraft(empty);
    expect(draft.units[0].topics).toEqual([]);
    expect(mockCreate).not.toHaveBeenCalled();
  });

  test('retries once on malformed JSON and succeeds on the second attempt', async () => {
    mockCreate
      .mockResolvedValueOnce(completionWith('not json')) // JSON.stringify('not json') => a valid JSON string of a string, not an object -> will fail validateGeneratedTopics since parsed.topics undefined
      .mockResolvedValueOnce(completionWith({ topics: [{ unitOrder: 0, topicOrder: 1, objectives: [], lessons: [] }] }));

    const draft = await generateLearningPathDraft(normalized);

    expect(mockCreate).toHaveBeenCalledTimes(2);
    expect(draft.units[0].topics[1].objectives).toEqual([]);
  });

  test('throws LearningPathGenerationError when the response is invalid JSON on both attempts', async () => {
    mockCreate.mockResolvedValue({ choices: [{ message: { content: '{not valid json' } }] });
    await expect(generateLearningPathDraft(normalized)).rejects.toThrow(LearningPathGenerationError);
    expect(mockCreate).toHaveBeenCalledTimes(2);
  });

  test('throws LearningPathGenerationError when Groq fails on both attempts (timeout/provider error)', async () => {
    mockCreate.mockRejectedValue(new Error('rate limited'));
    await expect(generateLearningPathDraft(normalized)).rejects.toThrow(LearningPathGenerationError);
    // 1st attempt: both chain entries fail and go on cooldown (2 calls). 2nd
    // attempt: both entries are still cooling down, so callGroq throws
    // immediately without calling fetch again.
    expect(mockCreate).toHaveBeenCalledTimes(2);
  });

  test('falls back to the secondary model when the primary model call fails', async () => {
    mockCreate
      .mockRejectedValueOnce(new Error('primary down'))
      .mockResolvedValueOnce(completionWith({ topics: [{ unitOrder: 0, topicOrder: 0, objectives: [], lessons: [] }] }));

    const draft = await generateLearningPathDraft(normalized);

    expect(mockCreate).toHaveBeenCalledTimes(2);
    expect(draft.units[0].topics[0]).toMatchObject({ objectives: [] });
  });

  test('throws when the response contains only unknown topic references (empty output after validation)', async () => {
    mockCreate.mockResolvedValue(completionWith({ topics: [{ unitOrder: 9, topicOrder: 9, objectives: [], lessons: [] }] }));
    await expect(generateLearningPathDraft(normalized)).rejects.toThrow(LearningPathGenerationError);
  });
});

describe('generateLearningPathDraft — grade-fit wiring', () => {
  beforeEach(() => jest.clearAllMocks());

  const singleTopicNormalized = {
    metadata: { grade: '6', subject: 'Mathematics' },
    units: [{ title: 'Numbers', order: 0, topics: [
      { title: 'Whole Numbers', order: 0, subtopics: [], content: [] },
    ] }],
  };
  const PASS = { quality: { readingGrade: 5, sentenceLength: 10, judgeScores: { learn: { ageAppropriate: 5 } }, issues: [] }, failed: false };
  const FAIL = { quality: { readingGrade: 12, sentenceLength: 30, judgeScores: null, issues: ['Learn text too advanced'] }, failed: true };

  test('a passing grade-fit check stores quality with no regeneration', async () => {
    mockRetrieveGroundingContext.mockResolvedValue({ context: 'text', meta: { selected: 1 } });
    mockGenerateStructuredContent.mockResolvedValueOnce({ ok: true, whatYoullLearn: ['x'], blocks: [{ type: 'explanation', text: 'x' }] });
    mockCreate.mockResolvedValueOnce(completionWith({ listenParts: [], questions: [] })); // companions
    mockCheckGradeFit.mockResolvedValueOnce(PASS);

    const draft = await generateLearningPathDraft(singleTopicNormalized);

    expect(draft.units[0].topics[0].quality).toEqual(PASS.quality);
    expect(draft.units[0].topics[0].status).toBe('ready');
    expect(mockGenerateStructuredContent).toHaveBeenCalledTimes(1); // no regen call
  });

  test('a failing check regenerates once, then passes: content replaced, status stays ready', async () => {
    mockRetrieveGroundingContext.mockResolvedValue({ context: 'text', meta: { selected: 1 } });
    mockGenerateStructuredContent
      .mockResolvedValueOnce({ ok: true, whatYoullLearn: ['x'], blocks: [{ type: 'explanation', text: 'original, too advanced' }] })
      .mockResolvedValueOnce({ ok: true, whatYoullLearn: ['x'], blocks: [{ type: 'explanation', text: 'simplified version' }] });
    mockCreate.mockResolvedValue(completionWith({ listenParts: [], questions: [] })); // companions, both rounds
    mockCheckGradeFit.mockResolvedValueOnce(FAIL).mockResolvedValueOnce(PASS);

    const draft = await generateLearningPathDraft(singleTopicNormalized);

    expect(mockGenerateStructuredContent).toHaveBeenCalledTimes(2);
    expect(mockGenerateStructuredContent.mock.calls[1][0].qualityFeedback).toBe('Learn text too advanced');
    expect(draft.units[0].topics[0].content.blocks[0].text).toBe('simplified version');
    expect(draft.units[0].topics[0].status).toBe('ready');
    expect(draft.units[0].topics[0].quality).toEqual(PASS.quality);
  });

  test('still failing after the one regeneration: needs_teacher_input with a teacherHint, content kept', async () => {
    mockRetrieveGroundingContext.mockResolvedValue({ context: 'text', meta: { selected: 1 } });
    mockGenerateStructuredContent.mockResolvedValue({ ok: true, whatYoullLearn: ['x'], blocks: [{ type: 'explanation', text: 'still too advanced' }] });
    mockCreate.mockResolvedValue(completionWith({ listenParts: [], questions: [] }));
    mockCheckGradeFit.mockResolvedValueOnce(FAIL).mockResolvedValueOnce(FAIL);

    const draft = await generateLearningPathDraft(singleTopicNormalized);

    const topic = draft.units[0].topics[0];
    expect(topic.status).toBe('needs_teacher_input');
    expect(topic.teacherHint).toContain('Learn text too advanced');
    expect(topic.content.blocks[0].text).toBe('still too advanced');
  });

  test('checkGradeFit throwing is swallowed — topic keeps its original content and status', async () => {
    mockRetrieveGroundingContext.mockResolvedValue({ context: 'text', meta: { selected: 1 } });
    mockGenerateStructuredContent.mockResolvedValueOnce({ ok: true, whatYoullLearn: ['x'], blocks: [{ type: 'explanation', text: 'x' }] });
    mockCreate.mockResolvedValueOnce(completionWith({ listenParts: [], questions: [] }));
    mockCheckGradeFit.mockRejectedValueOnce(new Error('judge down'));

    const draft = await generateLearningPathDraft(singleTopicNormalized);

    expect(draft.units[0].topics[0].status).toBe('ready');
    expect(draft.units[0].topics[0].content.blocks[0].text).toBe('x');
  });
});

describe('matchChapter — real NCERT registry, keyword overlap not position', () => {
  const metadata = { grade: '6', subject: 'Mathematics' };

  test('"Understanding Fractions" matches chapter 7 (Fractions), not a positional guess', () => {
    const match = matchChapter(
      { unitOrder: 1, topicTitle: 'Understanding Fractions', subtopics: ['Equivalent fractions', 'Comparing fractions'] },
      metadata
    );
    expect(match).not.toBeNull();
    expect(match.chapter).toBe(7);
    expect(match.pdfFile).toBe('fegp107.pdf');
  });

  test('"Symmetry" matches chapter 9', () => {
    const match = matchChapter(
      { unitOrder: 0, topicTitle: 'Symmetry', subtopics: ['Line of Symmetry'] },
      metadata
    );
    expect(match).not.toBeNull();
    expect(match.chapter).toBe(9);
  });

  test('an old-syllabus topic with no clean match ("Knowing Our Numbers") returns null, never a random chapter', () => {
    const match = matchChapter(
      { unitOrder: 0, topicTitle: 'Knowing Our Numbers', subtopics: ['Reading and writing large numbers', 'Comparing and ordering numbers'] },
      metadata
    );
    expect(match).toBeNull();
  });
});

describe('generateCompanions', () => {
  beforeEach(() => jest.clearAllMocks());
  const topicRef = { unitOrder: 0, topicOrder: 0, unitTitle: 'Numbers', topicTitle: 'Whole Numbers', subtopics: [] };
  const metadata = { grade: '6', subject: 'Mathematics', curriculum: 'CBSE' };
  const content = { whatYoullLearn: ['Add two numbers'], blocks: [{ type: 'explanation', text: 'Adding numbers together.' }], contentType: 'mathematics' };

  test('returns listenParts and practiceQuiz matching the frontend shape', async () => {
    mockCreate.mockResolvedValueOnce(completionWith({
      listenParts: [{ heading: 'Intro', text: 'Let us add numbers.', keyIdea: 'Addition combines numbers', pauseThink: { question: 'What is 2+2?', options: ['3', '4', '5', '6'], correctIndex: 1 } }],
      questions: [{ type: 'mcq', question: 'What is 2+2?', options: ['3', '4', '5', '6'], correct: 1, hint: 'Count on', explanation: 'Two plus two is four.' }],
    }));

    const result = await generateCompanions(topicRef, metadata, content);

    expect(result.listenParts[0]).toMatchObject({ heading: 'Intro', text: 'Let us add numbers.', keyIdea: 'Addition combines numbers' });
    expect(result.listenParts[0].pauseThink).toEqual({ question: 'What is 2+2?', options: ['3', '4', '5', '6'], correctIndex: 1 });
    expect(result.practiceQuiz[0]).toMatchObject({ type: 'mcq', question: 'What is 2+2?' });
  });

  test('a Groq failure returns null rather than throwing', async () => {
    mockCreate.mockRejectedValue(new Error('rate limited'));
    const result = await generateCompanions(topicRef, metadata, content);
    expect(result).toBeNull();
  });

  test('invalid JSON returns null rather than throwing', async () => {
    mockCreate.mockResolvedValueOnce({ choices: [{ message: { content: 'not json' } }] });
    const result = await generateCompanions(topicRef, metadata, content);
    expect(result).toBeNull();
  });

  test('drops a math fill_blank question whose calculation fails arithmetic verification', async () => {
    mockCreate.mockResolvedValueOnce(completionWith({
      listenParts: [],
      questions: [
        { type: 'fill_blank', question: '2 cats have ___ legs.', correct: '8', calculation: '2 * 4 = 8', hint: 'h', explanation: 'e' },
        { type: 'fill_blank', question: '3 cats have ___ legs.', correct: '20', calculation: '3 * 4 = 20', hint: 'h', explanation: 'e' },
      ],
    }));

    const result = await generateCompanions(topicRef, metadata, content);

    expect(result.practiceQuiz).toHaveLength(1);
    expect(result.practiceQuiz[0].correct).toBe('8');
  });

  test('for a non-math topic, the "calculation" field is never used to drop a question', async () => {
    mockCreate.mockResolvedValueOnce(completionWith({
      listenParts: [],
      questions: [{ type: 'fill_blank', question: 'Sky is ___.', correct: 'blue', hint: 'h', explanation: 'e' }],
    }));

    const result = await generateCompanions(topicRef, { ...metadata, subject: 'English' }, { ...content, contentType: 'theory' });

    expect(result.practiceQuiz).toHaveLength(1);
  });
});

describe('knowledgeTopic — no chapter match still generates content', () => {
  test('an old-syllabus topic with no registry match gets chapterMatched:false and real content, not unknown', async () => {
    mockGenerateStructuredContent.mockImplementation(async (input) => {
      expect(input.chapterMatched).toBe(false);
      expect(input.unitTitle).toBe('Knowing Our Numbers');
      return { ok: true, whatYoullLearn: ['x'], blocks: [{ type: 'explanation', text: 'Whole numbers explained.' }] };
    });

    const { knowledgeTopic } = require('../../services/curriculumUpload/aiGeneration');
    const result = await knowledgeTopic(
      { unitOrder: 0, topicOrder: 0, unitTitle: 'Knowing Our Numbers', topicTitle: 'Knowing Our Numbers', subtopics: ['Reading and writing large numbers'] },
      { grade: '6', subject: 'Mathematics', curriculum: 'CBSE' }
    );

    expect(result).not.toBeNull();
    expect(result.groundingSource).toBe('model_knowledge');
    expect(mockGenerateStructuredContent).toHaveBeenCalledTimes(1);
  });
});

describe('generateLearningPathDraft — bounded concurrency', () => {
  test('never runs more than DRAFT_CONCURRENCY (2) knowledge-tier generations at once', async () => {
    mockRetrieveGroundingContext.mockResolvedValue(null);
    let inFlight = 0;
    let maxInFlight = 0;
    mockGenerateStructuredContent.mockImplementation(async () => {
      inFlight++;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await new Promise((r) => setTimeout(r, 10));
      inFlight--;
      return { ok: true, whatYoullLearn: ['x'], blocks: [{ type: 'explanation', text: 'x' }] };
    });
    mockCreate.mockResolvedValue(completionWith({ topics: [] }));

    const manyTopics = {
      metadata: { grade: '6', subject: 'Science' },
      units: [{
        title: 'Unit', order: 0,
        topics: Array.from({ length: 6 }, (_, i) => ({ title: `Topic ${i}`, order: i, subtopics: [], content: [] })),
      }],
    };

    await generateLearningPathDraft(manyTopics);
    expect(maxInFlight).toBeLessThanOrEqual(2);
  });
});
