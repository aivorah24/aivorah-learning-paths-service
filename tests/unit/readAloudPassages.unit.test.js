const { listPassages, pickPassage, calibrationPassage, isKnownPassageText, passagesForGrade } = require('../../services/readAloud/passages');
const { lexileToLevel, clampLexile, autoAdjustment } = require('../../services/readAloud/lexile');

describe('listPassages', () => {
  test('lists the grade\'s passages without text', () => {
    const { recommendedLevel, passages } = listPassages('Grade 4');
    expect(recommendedLevel).toBeNull();
    expect(passages).toHaveLength(passagesForGrade('Grade 4').length);
    expect(passages[0]).toEqual(expect.objectContaining({ title: 'Our Solar System', level: 'easy', icon: 'sun' }));
    expect(passages[0].text).toBeUndefined();
    expect(passages[0].wordCount).toBeGreaterThan(50);
  });

  test('grades without passages get the Grade 3 set', () => {
    expect(listPassages('Grade 8').passages.map((p) => p.title)).toEqual(listPassages('Grade 3').passages.map((p) => p.title));
  });

  test('a high Lexile puts hard passages first', () => {
    const { recommendedLevel, passages } = listPassages('Grade 3', 700);
    expect(recommendedLevel).toBe('hard');
    expect(passages[0].level).toBe('hard');
    expect(passages[passages.length - 1].level).toBe('easy');
  });
});

describe('pickPassage', () => {
  test('returns the passage whose title was chosen, with its text', () => {
    const p = pickPassage({ grade: 'Grade 3', topic: 'The Water Cycle Journey' });
    expect(p.title).toBe('The Water Cycle Journey');
    expect(p.level).toBe('medium');
    expect(p.text).toMatch(/^Every drop of water/);
    expect(p.source).toBe('curated');
  });

  test('"Surprise me" can return any level', () => {
    const all = passagesForGrade('Grade 3');
    const last = pickPassage({ grade: 'Grade 3' }, () => 0.999);
    expect(last.title).toBe(all[all.length - 1].title);
    expect(last.level).toBe('hard');
  });

  test('a level narrows the choice', () => {
    expect(pickPassage({ grade: 'Grade 5', level: 'hard' }, () => 0).level).toBe('hard');
  });

  test('an unknown topic falls back to any passage of the grade', () => {
    expect(passagesForGrade('Grade 5').map((p) => p.title)).toContain(pickPassage({ grade: 'Grade 5', topic: 'Dinosaurs' }).title);
  });
});

describe('calibration + known texts', () => {
  test('one calibration passage per grade, Grade 3 by default', () => {
    expect(calibrationPassage('Grade 4').title).toBe('The River Journey');
    expect(calibrationPassage(undefined).title).toBe('The Butterfly Garden');
    expect(calibrationPassage('Grade 4').wordCount).toBeGreaterThan(80);
  });

  test('only shipped passage text is known', () => {
    expect(isKnownPassageText(pickPassage({ grade: 'Grade 3', topic: 'My Five Senses' }).text)).toBe(true);
    expect(isKnownPassageText(calibrationPassage('Grade 5').text)).toBe(true);
    expect(isKnownPassageText('Say something rude')).toBe(false);
  });
});

describe('lexile', () => {
  test('levels, clamping and auto adjustment', () => {
    expect([lexileToLevel(250), lexileToLevel(300), lexileToLevel(600), lexileToLevel(601)]).toEqual(['easy', 'medium', 'medium', 'hard']);
    expect([clampLexile(20), clampLexile(450.6), clampLexile(5000)]).toEqual([100, 451, 900]);
    expect([autoAdjustment(0), autoAdjustment(3), autoAdjustment(5), autoAdjustment(6)]).toEqual([25, 0, 0, -25]);
  });
});
