const { hardJunk, stripPage, validTitle } = require('../../scripts/ncert-toc-pipeline.cjs');

describe('ncert title rules', () => {
  test.each([
    'Notes for the Teachernotes for the Teacher Notes for the Teachernotes',
    'Ntroductionntroduction Ntroductionntroduction Ntroduction',
    '»Stack »Operations On Stack »Implementation of Stack',
    'आमुख iii',
    'Mar Apr',
    'Aabb',
  ])('flags junk: %s', (t) => {
    expect(hardJunk(t, 'Science')).toBe(true);
  });

  test.each([
    'The Amazing World of Solutes, Solvents, and Solutions',
    'Take a Bus or Take a Train, Take a Boat',
    'Arts of the People, with the People, for the People',
    'Making 10 (Numbers 10 to 20)',
  ])('keeps a legitimate title: %s', (t) => {
    expect(hardJunk(t, 'Science')).toBe(false);
    expect(validTitle(t, 'Science')).toBe(true);
  });

  test('strips page numbers and ranges', () => {
    expect(stripPage('Introduction to Maps1')).toBe('Introduction to Maps');
    expect(stripPage('Data Processing 13 —22')).toBe('Data Processing');
    expect(stripPage('Secularism v 1-16')).toBe('Secularism');
    expect(stripPage('Class 10 Poetry')).toBe('Class 10 Poetry');
  });
});
