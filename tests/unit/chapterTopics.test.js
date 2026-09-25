const { splitSections, validateTopic, mergeTopics, quoteInText, norm, parseJson } = require('../../scripts/lib/chapterTopics.cjs');

const SECTION = 'Volume is how loud or soft a sound is. Pitch is how high or low a sound is. Actors use both to show feelings.';

describe('chapterTopics', () => {
  test('quote must appear in the source text (exact or near-exact)', () => {
    const t = norm(SECTION);
    expect(quoteInText('Pitch is how high or low a sound is.', t)).toBe(true);
    expect(quoteInText('pitch is how HIGH or low a sound is', t)).toBe(true);
    expect(quoteInText('Rhythm is how fast the beat moves in a song', t)).toBe(false);
  });

  test('rejects a topic that is not grounded in the section', () => {
    const good = { name: 'Pitch in Theatre', key_terms: ['pitch'], explanation: 'Pitch is the highness or lowness of a sound. Actors change pitch to show feelings.', quote: 'Pitch is how high or low a sound is.' };
    expect(validateTopic(good, SECTION).ok).toBe(true);
    expect(validateTopic({ ...good, quote: 'Sound travels faster in water than in air today' }, SECTION)).toEqual({ ok: false, reason: 'quote-not-in-text' });
    expect(validateTopic({ ...good, key_terms: ['gravity'] }, SECTION)).toEqual({ ok: false, reason: 'key-terms-not-in-text' });
    expect(validateTopic({ ...good, name: 'Chapter 3' }, SECTION).reason).toBe('bad-name');
    expect(validateTopic({ ...good, explanation: 'Too short.' }, SECTION).reason).toBe('bad-explanation-length');
  });

  test('merge de-duplicates by name across sections and keeps order', () => {
    const a = { name: 'Pitch', key_terms: ['pitch'], explanation: 'x'.repeat(50), quote: 'q' };
    const merged = mergeTopics([[a, { ...a, name: 'Volume' }], [{ ...a, name: 'pitch' }, { ...a, name: 'Tempo' }]]);
    expect(merged.map((t) => t.name)).toEqual(['Pitch', 'Volume', 'Tempo']);
  });

  test('sections are bounded and tiny fragments dropped', () => {
    const para = 'word '.repeat(300);
    const sections = splitSections(`${para}\n\n${para}\n\n${para}\n\nshort`, 700);
    expect(sections.every((s) => s.length <= 700)).toBe(true);
    expect(sections.join(' ')).not.toContain('short');
  });

  test('parses JSON wrapped in code fences or extra prose', () => {
    expect(parseJson('```json\n{"topics":[]}\n```')).toEqual({ topics: [] });
    expect(parseJson('Here you go: {"topics":[{"name":"a"}]} thanks')).toEqual({ topics: [{ name: 'a' }] });
    expect(parseJson('not json')).toBeNull();
  });
});
