const { normalizeQuizQuestion } = require('../../services/quizNormalize');

describe('normalizeQuizQuestion — fill_blank', () => {
  test('passes through with an empty options array and a trimmed string answer', () => {
    const result = normalizeQuizQuestion({
      type: 'fill_blank', question: 'The sky is ___.', correct: '  blue  ', hint: 'h', explanation: 'e',
    });
    expect(result).toEqual({
      type: 'fill_blank', question: 'The sky is ___.', options: [], correct: 'blue', hint: 'h', explanation: 'e',
    });
  });

  test('missing hint/explanation default to empty strings, not undefined', () => {
    const result = normalizeQuizQuestion({ type: 'fill_blank', question: 'Q', correct: 'x' });
    expect(result.hint).toBe('');
    expect(result.explanation).toBe('');
  });
});

describe('normalizeQuizQuestion — mcq', () => {
  test('the option text marked correct is still correct after shuffling, whatever position it lands on', () => {
    for (let i = 0; i < 20; i++) { // shuffle is random — run many times to catch position bugs
      const result = normalizeQuizQuestion({
        type: 'mcq', question: 'Q', options: ['wrong1', 'wrong2', 'RIGHT', 'wrong3'], correct: 2, hint: 'h', explanation: 'e',
      });
      expect(result.options[result.correct]).toBe('RIGHT');
      expect(result.options).toHaveLength(4);
    }
  });

  test('a letter answer (A/B/C/D) is converted to the matching 0-based index before shuffling', () => {
    const result = normalizeQuizQuestion({
      type: 'mcq', question: 'Q', options: ['w1', 'w2', 'RIGHT', 'w3'], correct: 'C', hint: 'h', explanation: 'e',
    });
    expect(result.options[result.correct]).toBe('RIGHT');
  });

  test('a lowercase letter answer also works', () => {
    const result = normalizeQuizQuestion({
      type: 'mcq', question: 'Q', options: ['RIGHT', 'w2', 'w3', 'w4'], correct: 'a', hint: 'h', explanation: 'e',
    });
    expect(result.options[result.correct]).toBe('RIGHT');
  });

  test('an unrecognised correct value defaults to index 0', () => {
    const result = normalizeQuizQuestion({
      type: 'mcq', question: 'Q', options: ['RIGHT', 'w2', 'w3', 'w4'], correct: undefined, hint: 'h', explanation: 'e',
    });
    expect(result.options[result.correct]).toBe('RIGHT');
  });

  test('leading "A. " / "B. " style prefixes are stripped from option text', () => {
    const result = normalizeQuizQuestion({
      type: 'mcq', question: 'Q',
      options: ['A. wrong1', 'B. wrong2', 'C. RIGHT', 'D. wrong3'],
      correct: 2, hint: 'h', explanation: 'e',
    });
    expect(result.options).toEqual(expect.arrayContaining(['wrong1', 'wrong2', 'RIGHT', 'wrong3']));
    expect(result.options[result.correct]).toBe('RIGHT');
  });

  test('all 4 original option texts are preserved after shuffling (nothing dropped or duplicated)', () => {
    const original = ['alpha', 'beta', 'gamma', 'delta'];
    const result = normalizeQuizQuestion({ type: 'mcq', question: 'Q', options: original, correct: 0 });
    expect([...result.options].sort()).toEqual([...original].sort());
  });
});
