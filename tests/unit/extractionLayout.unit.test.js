const { pageLines, docxHtmlToText } = require('../../services/curriculumUpload/extraction');

// pdf.js text item: x/y come from transform[4]/transform[5].
const item = (str, x, y, width) => ({ str, transform: [1, 0, 0, 1, x, y], width });

test('PDF: table cells stay apart and rows are aligned to the header columns', () => {
  const text = pageLines([
    item('Unit 1: Numbers', 46, 700, 120),
    item('Topic', 53, 680, 20), item('Subtopics', 125, 680, 35), item('Objectives', 220, 680, 40),
    item('Integers', 53, 660, 30), item('Positive; negative', 125, 660, 70), item('Compare integers', 220, 660, 60),
    item('Fractions', 53, 640, 35), item('Compare fractions', 220, 640, 70),
  ]);
  expect(text.split('\n')).toEqual([
    'Unit 1: Numbers',
    'Topic\tSubtopics\tObjectives',
    'Integers\tPositive; negative\tCompare integers',
    'Fractions\t\tCompare fractions',
  ]);
});

test('PDF: a cell that wraps onto its own line joins its row; pieces of one phrase are not split', () => {
  const text = pageLines([
    item('Topic', 53, 680, 20), item('Objectives', 220, 680, 40),
    item('Ratio', 53, 660, 20), item('Solve simple', 220, 660, 50),
    item('proportion problems', 220, 650, 80),
    item('Grade:', 46, 600, 31), item(' 6', 77, 600, 10),
  ]);
  expect(text.split('\n')).toEqual(['Topic\tObjectives', 'Ratio\tSolve simple proportion problems', 'Grade: 6']);
});

test('Word: headings, paragraphs and list items are lines; each table row is one tab-separated line', () => {
  const html = '<h1>Grade 6 Maths</h1><p>Unit 1: Numbers</p><table><tr><td><p>Topic</p></td><td><p>Subtopics</p></td></tr>'
    + '<tr><td><p>Integers</p></td><td><p>Positive &amp; negative</p></td></tr></table><ul><li>Fractions</li></ul>';
  expect(docxHtmlToText(html)).toBe('Grade 6 Maths\nUnit 1: Numbers\nTopic\tSubtopics\nIntegers\tPositive & negative\nFractions');
});
