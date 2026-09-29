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

const { loadBookSections, matchTopicsToBook, sectionIndex, shortlist, sectionsForTopic, bookForTopic, buildTopicMatchPrompt } = require('../../services/curriculumUpload/bookMatch');

const tutor = (keyIdea, page) => ({ keyIdea, intro: keyIdea, examples: [{ title: 'Ex', problem: 'p', steps: [], answer: 'a', page }] });
const meta = { grade: '6', subject: 'Mathematics' };

beforeEach(() => {
  mockRows.length = 0;
  mockRows.push(
    { grade: 6, pdf_file: 'fegp102.pdf', section_no: 4, section_title: '2.4 Ray', page_from: 3, tutor: tutor('A ray starts at a point and goes on forever.', 3) },
    { grade: 6, pdf_file: 'fegp102.pdf', section_no: 5, section_title: '2.5 Angle', page_from: 5, tutor: tutor('Two rays from one point make an angle.', 5) },
    { grade: 6, pdf_file: 'fegp103.pdf', section_no: 3, section_title: '3.3 Patterns of Numbers on the Number Line', page_from: 5, tutor: tutor('Numbers sit on a line.', 5) },
    { grade: 7, pdf_file: 'gegp103.pdf', section_no: 6, section_title: '3.6 Locating and Comparing Decimals', page_from: 55, tutor: tutor('Compare decimals place by place.', 28) },
  );
  mockCallWithFallback.mockReset();
});

test('loads sections with the earliest reliable page', async () => {
  const sections = await loadBookSections('Grade 6', 'Mathematics');
  expect(sections.map((s) => [s.id, s.page])).toEqual([['S1', 3], ['S2', 5], ['S3', 5], ['S4', 28]]);
});

test('no grade or subject -> no sections', async () => {
  expect(await loadBookSections('', 'Mathematics')).toEqual([]);
  expect(await loadBookSections('6', '')).toEqual([]);
});

test('shortlist: rare, specific words win, plural and singular match ("rays" -> "2.4 Ray")', async () => {
  const index = sectionIndex(await loadBookSections('6', 'Mathematics'));
  expect(shortlist(index, 'Rays and angles', 'Basic Geometrical Ideas', 6).map((s) => s.title).slice(0, 2).sort()).toEqual(['2.4 Ray', '2.5 Angle']);
  expect(shortlist(index, 'Comparing decimals', 'Decimals', 6)[0].title).toBe('3.6 Locating and Comparing Decimals');
  expect(shortlist(index, 'Successor and predecessor', 'Whole Numbers', 6)).toEqual([]);
});

test('one small call per topic; picks are limited to that subtopic\'s own shortlist', async () => {
  mockCallWithFallback.mockResolvedValueOnce(JSON.stringify({ picks: [['S1', 'S2'], ['S99', 'S4']] }));
  const refs = [{ topicTitle: 'Lines', unitTitle: 'Geometry', subtopics: ['Rays and angles', 'Comparing decimals'] }];
  const match = (await matchTopicsToBook(refs, meta)).get(0);
  expect(mockCallWithFallback).toHaveBeenCalledTimes(1);
  expect(match.subtopics.map((s) => s.sections.map((x) => x.id))).toEqual([['S1', 'S2'], ['S4']]);
  expect(sectionsForTopic(match).map((s) => s.id)).toEqual(['S1', 'S2', 'S4']);
});

test('the match prompt stays small: only shortlisted candidates, never the whole book', async () => {
  const sections = await loadBookSections('6', 'Mathematics');
  const prompt = buildTopicMatchPrompt({ topicTitle: 'Lines', subtopics: ['Rays and angles'] }, [[sections[0]]], 6, 'Mathematics');
  expect(prompt).toContain('2.4 Ray');
  expect(prompt).not.toContain('Decimals');
});

test('no candidates anywhere -> no AI call, every subtopic unmatched', async () => {
  const match = (await matchTopicsToBook([{ topicTitle: 'Whole Numbers', subtopics: ['Successor and predecessor'] }], meta)).get(0);
  expect(mockCallWithFallback).not.toHaveBeenCalled();
  expect(match.subtopics).toEqual([{ title: 'Successor and predecessor', section: null, sections: [] }]);
});

test('a failed or invalid AI answer leaves the topic unmatched, never throws', async () => {
  mockCallWithFallback.mockRejectedValueOnce(new Error('rate limited'));
  const refs = [{ topicTitle: 'Lines', subtopics: ['Rays and angles'] }];
  expect((await matchTopicsToBook(refs, meta)).get(0).subtopics[0].sections).toEqual([]);
  mockCallWithFallback.mockResolvedValueOnce('not json');
  expect((await matchTopicsToBook(refs, meta)).get(0).subtopics[0].sections).toEqual([]);
});

test('a topic without subtopics is matched by its own title', async () => {
  mockCallWithFallback.mockResolvedValueOnce(JSON.stringify({ picks: [['S3']] }));
  const match = (await matchTopicsToBook([{ topicTitle: 'Number line', subtopics: [] }], meta)).get(0);
  expect(match.subtopics).toEqual([expect.objectContaining({ title: 'Number line', sections: [expect.objectContaining({ id: 'S3' })] })]);
});

test('bookForTopic opens at the first section and lists a page per subtopic', async () => {
  const sections = await loadBookSections('6', 'Mathematics');
  const match = { subtopics: [{ title: 'Rays and angles', section: sections[0], sections: [sections[0]] }, { title: 'Successor', section: null, sections: [] }] };
  const book = bookForTopic(match, sectionsForTopic(match));
  expect(book).toMatchObject({ pdfFile: 'fegp102.pdf', pdfPage: 3, grade: 6 });
  expect(book.pages).toEqual([
    expect.objectContaining({ subtopic: 'Rays and angles', pdfPage: 3, section: '2.4 Ray' }),
    { subtopic: 'Successor', pdfFile: null, sections: [] },
  ]);
});
