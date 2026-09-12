const mockCreate = jest.fn();
jest.mock('groq-sdk', () => jest.fn().mockImplementation(() => ({
  chat: { completions: { create: mockCreate } },
})));

const {
  generateLearningPathDraft,
  collectTopicRefs,
  validateGeneratedTopics,
  mergeGeneratedContent,
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

describe('validateGeneratedTopics', () => {
  const refs = [{ unitOrder: 0, topicOrder: 0 }, { unitOrder: 0, topicOrder: 1 }];

  test('accepts a well-formed response matching known topics', () => {
    const result = validateGeneratedTopics({
      topics: [{ unitOrder: 0, topicOrder: 0, objectives: ['Add two numbers'], lessons: [{ title: 'Intro', summary: 'x' }] }],
    }, refs);
    expect(result.valid).toBe(true);
    expect(result.topics).toEqual([{ unitOrder: 0, topicOrder: 0, objectives: ['Add two numbers'], lessons: [{ title: 'Intro', summary: 'x' }] }]);
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
});

describe('generateLearningPathDraft grounding', () => {
  beforeEach(() => jest.clearAllMocks());

  test('sends each topic\'s source text and curriculum metadata to Groq', async () => {
    mockCreate.mockResolvedValueOnce(completionWith({
      topics: [{ unitOrder: 0, topicOrder: 0, objectives: [], lessons: [] }],
    }));

    await generateLearningPathDraft(normalized);

    const sentPrompt = mockCreate.mock.calls[0][0].messages[0].content;
    expect(sentPrompt).toContain('Covers place value and number lines.');
    expect(sentPrompt).toContain('Grade 6');
    expect(sentPrompt).toContain('Mathematics');
    expect(sentPrompt).toMatch(/ground/i);
  });
});

describe('generateLearningPathDraft', () => {
  beforeEach(() => jest.clearAllMocks());

  test('returns a valid draft on the first successful Groq response', async () => {
    mockCreate.mockResolvedValueOnce(completionWith({
      topics: [{ unitOrder: 0, topicOrder: 0, objectives: ['Add numbers'], lessons: [] }],
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
