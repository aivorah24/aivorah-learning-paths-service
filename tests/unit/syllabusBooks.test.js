const { chaptersFor, subjectsFor } = require('../../services/syllabus-map');

describe('current-edition books (Grade 8)', () => {
  const titles = (subject) => chaptersFor(8, subject).map((c) => c.title);

  test('English lists only Poorvi, not the superseded Honeydew / It So Happened', () => {
    const s = subjectsFor('Grade 8').find((x) => x.subject === 'English');
    expect(s.books).toEqual(['Poorvi']);
    expect(titles('English')).not.toContain('The Best Christmas Present');
  });

  test('Maths shows both Ganita Prakash volumes with continuous numbering', () => {
    const c = chaptersFor(8, 'Mathematics');
    expect(c.map((x) => x.chapter)).toEqual(Array.from({ length: 14 }, (_, i) => i + 1));
    expect(subjectsFor('Grade 8').find((x) => x.subject === 'Mathematics').books).toEqual(['Ganita Prakash, Part 1', 'Ganita Prakash, Part 2']);
    expect(titles('Mathematics')).toContain('Fractions in Disguise');
  });

  test('Science shows Curiosity only, with no dummy titles', () => {
    expect(subjectsFor('Grade 8').find((x) => x.subject === 'Science').books).toEqual(['Curiosity']);
    expect(titles('Science').filter((t) => /Mar Apr|Or Some|Aabb|Fit India/.test(t))).toEqual([]);
  });

  test('Social Science has real chapter titles, not textbook section labels', () => {
    const t = titles('Social Science');
    expect(t).toContain('Natural Resources and Their Use');
    expect(t).toContain('Dynamics of Population');
    expect(t.filter((x) => /^(Think About It|Let Us Explore|Legend)$/i.test(x))).toEqual([]);
  });

  test('older grades are unaffected by the edition rule', () => {
    expect(subjectsFor('Grade 11').find((x) => x.subject === 'Economics').chapters.length).toBeGreaterThan(0);
  });
});
