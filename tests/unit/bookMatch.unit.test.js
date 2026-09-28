const mockRows = [];
jest.mock('../../services/supabase', () => {
  const chain = {
    select: () => chain, in: () => chain, ilike: () => chain,
    order: () => chain,
    then: (resolve) => resolve({ data: mockRows, error: null }),
  };
  return { from: () => chain };
});
const mockCallWithFallback = jest.fn();
jest.mock('../../services/llm/fallback', () => ({ callWithFallback: (...a) => mockCallWithFallback(...a) }));

const { loadBookSections, matchTopicsToBook, sectionsForTopic, bookForTopic, sectionWorkedExamples, parseMatch } = require('../../services/curriculumUpload/bookMatch');

const tutor = (page) => ({ intro: 'A ray starts at a point.', keyIdea: 'Rays go on forever.', examples: [{ problem: 'Name the ray.', steps: [{ say: 'Start at A', show: 'A' }], answer: 'AP', page }] });
const refs = [{ topicTitle: 'Basic Geometrical Ideas', unitTitle: 'Geometry', subtopics: ['Rays and angles', 'Decimals'] }];
const meta = { grade: '6', subject: 'Mathematics' };
const answer = (topic, subtopics) => JSON.stringify({ topics: [{ t: 'T0', topic, subtopics }] });

beforeEach(() => {
  mockRows.length = 0;
  mockRows.push(
    { grade: 6, pdf_file: 'fegp102.pdf', section_no: 4, section_title: '2.4 Ray', page_from: 3, tutor: tutor(3) },
    { grade: 7, pdf_file: 'gegp103.pdf', section_no: 4, section_title: '3.4 Decimal Place Value', page_from: 55, tutor: tutor(18) },
    { grade: 7, pdf_file: 'gegp103.pdf', section_no: 6, section_title: '3.6 Comparing Decimals', page_from: 55, tutor: tutor(28) },
  );
  mockCallWithFallback.mockReset();
});

test('loads sections with the earliest reliable page', async () => {
  const sections = await loadBookSections('Grade 6', 'Mathematics');
  expect(sections.map((s) => [s.id, s.page])).toEqual([['S1', 3], ['S2', 18], ['S3', 28]]);
});

test('no grade or subject -> no sections', async () => {
  expect(await loadBookSections('', 'Mathematics')).toEqual([]);
  expect(await loadBookSections('6', '')).toEqual([]);
});

test('majority vote: agreed chapter wins, most-picked section inside it', async () => {
  mockCallWithFallback
    .mockResolvedValueOnce(answer('S1', ['S1', 'S2']))
    .mockResolvedValueOnce(answer('S1', ['S1', 'S3']))
    .mockResolvedValueOnce(answer(null, [null, 'S3']));
  const match = (await matchTopicsToBook(refs, meta)).get(0);
  expect(match.topic.id).toBe('S1');
  expect(match.subtopics.map((s) => s.section?.id || null)).toEqual(['S1', 'S3']);
});

test('no majority -> null, unknown ids ignored', async () => {
  mockCallWithFallback
    .mockResolvedValueOnce(answer('S1', ['S99', 'S2']))
    .mockResolvedValueOnce(answer(null, [null, null]))
    .mockResolvedValueOnce(answer(null, [null, null]));
  const match = (await matchTopicsToBook(refs, meta)).get(0);
  expect(match.topic).toBeNull();
  expect(match.subtopics.map((s) => s.section)).toEqual([null, null]);
});

test('invalid answers every time -> empty map, never throws', async () => {
  mockCallWithFallback.mockResolvedValue('not json');
  expect((await matchTopicsToBook(refs, meta)).size).toBe(0);
});

test('parseMatch ignores topics that do not exist', () => {
  expect(parseMatch(JSON.stringify({ topics: [{ t: 'T5', topic: 'S1' }] }), refs, []).size).toBe(0);
});

test('bookForTopic opens at the first section and lists a page per subtopic', async () => {
  const sections = await loadBookSections('6', 'Mathematics');
  const match = { topic: null, subtopics: [{ title: 'Rays and angles', section: sections[0] }, { title: 'Successor', section: null }] };
  const book = bookForTopic(match, sectionsForTopic(match));
  expect(book).toMatchObject({ pdfFile: 'fegp102.pdf', pdfPage: 3, grade: 6 });
  expect(book.pages).toEqual([
    expect.objectContaining({ subtopic: 'Rays and angles', pdfPage: 3, section: '2.4 Ray' }),
    { subtopic: 'Successor', pdfFile: null },
  ]);
});

test('book examples are real textbook worked examples', async () => {
  const [section] = await loadBookSections('6', 'Mathematics');
  expect(sectionWorkedExamples(section)).toEqual([expect.objectContaining({ type: 'worked_example', problem: 'Name the ray.', finalAnswer: 'AP', exampleType: 'SOURCE_DERIVED', bookPage: 3 })]);
});
