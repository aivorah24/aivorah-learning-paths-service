const mockCallWithFallback = jest.fn();
jest.mock('../../services/llm/fallback', () => ({ callWithFallback: (...a) => mockCallWithFallback(...a) }));

const { scoreReading, feedbackFor, fallbackFeedback, readingLevel } = require('../../services/readAloud/assessment');

beforeEach(() => jest.clearAllMocks());

describe('scoreReading', () => {
  const passage = 'The cat sat on the mat.';

  test('counts words and computes accuracy and speed', () => {
    const s = scoreReading(passage, ['correct', 'correct', 'misread', 'correct', 'skipped', 'correct'], 30);
    expect(s).toEqual(expect.objectContaining({ totalWords: 6, correct: 4, misread: 1, skipped: 1, accuracy: 67, wcpm: 8, wpm: 12, duration: 30, level: 'developing' }));
    expect(s.errors).toEqual([
      { word: 'sat', position: 3, type: 'misread' },
      { word: 'the', position: 5, type: 'skipped' },
    ]);
  });

  test('never divides by zero', () => {
    const s = scoreReading('', [], 0);
    expect(s.accuracy).toBe(0);
    expect(s.wcpm).toBe(0);
  });

  test('levels by accuracy', () => {
    expect([readingLevel(95), readingLevel(80), readingLevel(60), readingLevel(59)]).toEqual(['excellent', 'good', 'developing', 'needs-practice']);
  });
});

describe('feedbackFor', () => {
  const score = { accuracy: 92, wcpm: 80, errors: [{ word: 'ocean', type: 'misread' }] };

  test('asks the LLM, naming the errors', async () => {
    mockCallWithFallback.mockResolvedValueOnce('  Great reading!  ');
    await expect(feedbackFor(score, 'Grade 4')).resolves.toBe('Great reading!');
    expect(mockCallWithFallback.mock.calls[0][0]).toContain('"ocean" (misread)');
    expect(mockCallWithFallback.mock.calls[0][0]).toContain('Grade 4');
  });

  test('falls back to fixed text when the LLM fails or is empty', async () => {
    mockCallWithFallback.mockRejectedValueOnce(new Error('all providers down'));
    await expect(feedbackFor(score)).resolves.toBe(fallbackFeedback(92));
    mockCallWithFallback.mockResolvedValueOnce('');
    await expect(feedbackFor({ ...score, accuracy: 40 })).resolves.toMatch(/^Nice try!/);
  });
});
