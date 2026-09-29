jest.mock('../../services/supabase', () => ({}));
const mockCallWithFallback = jest.fn();
jest.mock('../../services/llm/fallback', () => ({ callWithFallback: (...a) => mockCallWithFallback(...a) }));

const { sectionLearn, sectionListen, sectionPractice, assembleBookTopic, buildGapPrompt } = require('../../services/curriculumUpload/bookContent');

const science = {
  id: 'S7', grade: 6, pdfFile: 'fecu105.pdf', bookPath: 'grade6/science/fecu105.pdf', bookTitle: 'Curiosity', chapterTitle: 'Nutrition',
  title: '5.2 Nutrients', page: 8, tutor: null,
  learn: { whatYoullLearn: ['Name the main nutrients'], blocks: [{ type: 'explanation', text: 'Food has nutrients.' }] },
  listen: [{ card: null, text: '', lines: [{ text: 'Food gives us energy.' }, { text: 'Rice has carbohydrates.' }] }],
  quiz: [{ question: 'Rice is rich in?', options: ['Fat', 'Carbohydrates', 'Protein', 'Water'], correctIndex: 1, explanation: 'Rice is mostly starch.' }],
};

beforeEach(() => mockCallWithFallback.mockReset());

test('non-Maths sections use their pre-built Learn, Listen and Quiz as they are', () => {
  expect(sectionLearn(science)).toEqual([
    { type: 'explanation', text: 'From the book: 5.2 Nutrients (Grade 6, Curiosity, page 8)' },
    { type: 'explanation', text: 'Food has nutrients.' },
  ]);
  expect(sectionListen(science)).toEqual([{ heading: '5.2 Nutrients', text: 'Food gives us energy. Rice has carbohydrates.', keyIdea: '' }]);
  const [q] = sectionPractice(science);
  expect(q).toMatchObject({ type: 'mcq', question: 'Rice is rich in?', explanation: 'Rice is mostly starch.' });
  expect(q.options[q.correct]).toBe('Carbohydrates');
});

test('a section with no content adds nothing (no empty header)', () => {
  expect(sectionLearn({ ...science, learn: { blocks: [] } })).toEqual([]);
});

test('the same section matched to two subtopics appears once', async () => {
  const match = { subtopics: [{ title: 'Nutrients', section: science, sections: [science] }, { title: 'Food groups', section: science, sections: [science] }] };
  const content = await assembleBookTopic({ topicTitle: 'Food' }, match, { grade: '6', subject: 'Science' });
  expect(content.blocks.filter((b) => b.text?.startsWith('From the book'))).toHaveLength(1);
  expect(content.whatYoullLearn).toEqual(['Name the main nutrients']);
  expect(mockCallWithFallback).not.toHaveBeenCalled();
});

test('the gap prompt asks for exact facts at the student grade and never claims the textbook', () => {
  const prompt = buildGapPrompt('Successor', { topicTitle: 'Whole Numbers' }, { grade: '6', subject: 'Mathematics', curriculum: 'CBSE' });
  expect(prompt).toContain('Grade 6 Mathematics');
  expect(prompt).toContain('The textbook does not cover it');
  expect(prompt).toMatch(/Every fact and every calculation must be exactly right/);
});
