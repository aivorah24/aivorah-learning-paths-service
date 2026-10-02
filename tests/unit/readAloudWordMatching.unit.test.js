const { splitWords, norm, fuzzy, isEquivalent, matchWordsToPassage } = require('../../services/readAloud/wordMatching');

describe('splitWords / norm', () => {
  test('splits on spaces and dashes', () => {
    expect(splitWords('Reduce, Reuse — and well-known')).toEqual(['Reduce,', 'Reuse', 'and', 'well', 'known']);
    expect(splitWords('')).toEqual([]);
  });

  test('lower-cases and strips punctuation but keeps apostrophes inside', () => {
    expect(norm('"Earth\'s,')).toBe("earth's");
    expect(norm("'quoted'")).toBe('quoted');
  });
});

describe('fuzzy', () => {
  test('accepts exact words, homophones and British/US spellings', () => {
    expect(fuzzy('water', 'water')).toBe(true);
    expect(isEquivalent('there', 'their')).toBe(true);
    expect(fuzzy('colors', 'colours')).toBe(true);
  });

  test('accepts a one-letter slip on a long word but not on a short one', () => {
    expect(fuzzy('beautifull', 'beautiful')).toBe(true);
    expect(fuzzy('cat', 'cut')).toBe(false);
  });

  test('rejects unrelated words', () => {
    expect(fuzzy('river', 'mountain')).toBe(false);
    expect(fuzzy('', 'mountain')).toBe(false);
  });
});

describe('matchWordsToPassage', () => {
  const passage = splitWords('The sun heats water in the ocean.');

  test('a perfect read is all correct', () => {
    const { statuses, matchedUpTo } = matchWordsToPassage(['the', 'sun', 'heats', 'water', 'in', 'the', 'ocean'], passage);
    expect(statuses).toEqual(new Array(7).fill('correct'));
    expect(matchedUpTo).toBe(7);
  });

  test('a missed word is skipped and a wrong word is misread', () => {
    const { statuses } = matchWordsToPassage(['the', 'sun', 'water', 'in', 'a', 'ocean'], passage);
    expect(statuses[2]).toBe('skipped');
    expect(statuses[5]).toBe('misread');
    expect(statuses.filter((s) => s === 'correct')).toHaveLength(5);
  });

  test('joins "every day" to "everyday" and splits "cannot"', () => {
    expect(matchWordsToPassage(['every', 'day'], ['everyday']).statuses).toEqual(['correct']);
    expect(matchWordsToPassage(['cannot'], ['can', 'not']).statuses).toEqual(['correct', 'correct']);
  });

  test('final mode marks unread words skipped; live mode marks the next word current', () => {
    expect(matchWordsToPassage(['the', 'sun'], passage).statuses.slice(2)).toEqual(new Array(5).fill('skipped'));
    const live = matchWordsToPassage(['the', 'sun'], passage, true);
    expect(live.matchedUpTo).toBe(2);
    expect(live.statuses.slice(0, 4)).toEqual(['correct', 'correct', 'current', 'pending']);
  });

  test('handles silence and an empty passage', () => {
    expect(matchWordsToPassage([], passage).statuses).toEqual(new Array(7).fill('skipped'));
    expect(matchWordsToPassage([], passage, true).statuses[0]).toBe('current');
    expect(matchWordsToPassage(['hello'], [])).toEqual({ statuses: [], matchedUpTo: 0 });
  });
});
