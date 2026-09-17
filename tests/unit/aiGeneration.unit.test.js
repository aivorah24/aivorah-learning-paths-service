const mockCreate = jest.fn();
jest.mock('groq-sdk', () => jest.fn().mockImplementation(() => ({
  chat: { completions: { create: mockCreate } },
})));

const mockRetrieveGroundingContext = jest.fn();
jest.mock('../../services/curriculumUpload/groundedContent', () => ({
  retrieveGroundingContext: (...args) => mockRetrieveGroundingContext(...args),
}));

const mockGenerateStructuredContent = jest.fn();
jest.mock('../../services/curriculum/enrichment', () => ({
  generateStructuredContent: (...args) => mockGenerateStructuredContent(...args),
  classifyContentType: (subject) => (String(subject).toLowerCase() === 'mathematics' ? 'mathematics' : 'theory'),
}));

const {
  generateLearningPathDraft,
  collectTopicRefs,
  validateGeneratedTopics,
  mergeGeneratedContent,
  deriveObjectivesAndLessons,
  generateWorkedExample,
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
    mockCreate.mockResolvedValueOnce(completionWith({ topics: [{ unitOrder: 0, topicOrder: 1, objectives: [], lessons: [] }] }));

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
    const sentPrompt = mockCreate.mock.calls[0][0].messages[0].content;
    expect(sentPrompt).not.toContain('Whole Numbers');
    expect(sentPrompt).toContain('Fractions');
  });

  test('falls back to upload-text grounding when retrieval finds nothing — never invents NCERT content', async () => {
    mockRetrieveGroundingContext.mockResolvedValue(null);
    mockCreate.mockResolvedValueOnce(completionWith({
      topics: [
        { unitOrder: 0, topicOrder: 0, objectives: ['x'], lessons: [] },
        { unitOrder: 0, topicOrder: 1, objectives: [], lessons: [] },
      ],
    }));

    const draft = await generateLearningPathDraft(normalized);

    expect(mockGenerateStructuredContent).not.toHaveBeenCalled();
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
    // 2 attempts x (primary + fallback each retried inside callGroq) = 4 calls
    expect(mockCreate).toHaveBeenCalledTimes(4);
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
