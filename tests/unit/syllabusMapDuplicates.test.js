// Reads the real data/curricula files: one book described by two files must be listed once.
const syllabus = require('../../services/syllabus-map');

test('Grade 6 Science is its 12 chapters once, with the catalogued titles (it used to list every chapter twice)', () => {
  const science = syllabus.chaptersFor(6, 'Science');
  expect(science).toHaveLength(12);
  expect(new Set(science.map((c) => c.pdfFile)).size).toBe(12);
  expect(science.map((c) => c.title)).not.toContain('Abcabc');
  expect(science[6].title).toBe('Temperature and its Measurement');
});

test('Grade 6 Social Science is its 14 chapters once', () => {
  const social = syllabus.chaptersFor(6, 'Social Science');
  expect(social).toHaveLength(14);
  expect(new Set(social.map((c) => c.pdfFile)).size).toBe(14);
});
