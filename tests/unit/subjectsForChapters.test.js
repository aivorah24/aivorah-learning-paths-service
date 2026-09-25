const { subjectsFor } = require('../../services/syllabus-map');

describe('subjectsFor — chapter names for the Dashboard', () => {
  const grade8 = subjectsFor('Grade 8');

  test.each(['Science', 'English', 'Mathematics', 'Arts'])('%s returns titled chapters', (subject) => {
    const s = grade8.find((x) => x.subject === subject);
    expect(s.chapters.length).toBeGreaterThan(0);
    expect(s.chapters.length).toBe(new Set(s.chapters.map((c) => c.unitNo)).size);
    expect(s.chapters.every((c) => typeof c.title === 'string' && c.title.length > 0)).toBe(true);
  });

  test('Grade 8 Science carries no legacy dummy titles', () => {
    const titles = grade8.find((x) => x.subject === 'Science').chapters.map((c) => c.title);
    expect(titles.filter((t) => /Mar Apr|Or Some|Aabb|Fit India/i.test(t))).toEqual([]);
  });
});
