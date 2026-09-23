// Unit tests for services/qdrant.js's findTopicImages() — Phase 2b textbook
// image lookup: filters by grade/subject/chapter, ranks by keyword overlap.

const mockScroll = jest.fn();
jest.mock('@qdrant/js-client-rest', () => ({
  QdrantClient: jest.fn().mockImplementation(() => ({ scroll: (...args) => mockScroll(...args) })),
}));

const { findTopicImages } = require('../../services/qdrant');

beforeEach(() => {
  jest.clearAllMocks();
});

describe('findTopicImages', () => {
  test('missing grade/subject -> [] with no Qdrant call', async () => {
    expect(await findTopicImages({ topicTitle: 'x' })).toEqual([]);
    expect(mockScroll).not.toHaveBeenCalled();
  });

  test('ranks by keyword overlap and returns top matches with a clean caption', async () => {
    mockScroll.mockResolvedValueOnce({
      points: [
        { payload: { content_type: 'image', image_url: 'https://cdn/food-web.png', source_reference: 'NCERT Science Grade 6 | fecu105.pdf | Page 8', text: '[IMAGE] This image depicts a food web showing energy transfer between plants and animals in a forest.' } },
        { payload: { content_type: 'image', image_url: 'https://cdn/rocket.png', source_reference: 'NCERT Science Grade 6 | fecu105.pdf | Page 9', text: '[IMAGE] A rocket launching into space.' } },
      ],
      next_page_offset: null,
    });
    const result = await findTopicImages({
      grade: 6, subject: 'Science', pdfFile: 'fecu105.pdf',
      topicTitle: 'Food Web', subtopics: [], keyTerms: ['energy', 'plants', 'animals'],
    });
    expect(result).toHaveLength(1);
    expect(result[0].url).toBe('https://cdn/food-web.png');
    expect(result[0].caption).toBe('a food web showing energy transfer between plants and animals in a forest.');
  });

  test('conservative threshold — no strong match means no image, never an irrelevant guess', async () => {
    mockScroll.mockResolvedValueOnce({
      points: [{ payload: { content_type: 'image', image_url: 'https://cdn/rocket.png', source_reference: 'NCERT Science Grade 6 | fecu105.pdf', text: '[IMAGE] A rocket launching into space.' } }],
      next_page_offset: null,
    });
    const result = await findTopicImages({ grade: 6, subject: 'Science', pdfFile: 'fecu105.pdf', topicTitle: 'Food Web', subtopics: [], keyTerms: [] });
    expect(result).toEqual([]);
  });

  test('a strong keyword match from a DIFFERENT chapter is excluded once the topic chapter is known', async () => {
    mockScroll.mockResolvedValueOnce({
      points: [{ payload: { content_type: 'image', image_url: 'https://cdn/number-play.png', source_reference: 'NCERT Maths Grade 6 | fegp1_ch03.pdf | Page 4', text: '[IMAGE] Children with number speech bubbles showing place value and digits.' } }],
      next_page_offset: null,
    });
    const result = await findTopicImages({
      grade: 6, subject: 'Mathematics', pdfFile: 'fecu105.pdf', // "Knowing Our Numbers" chapter
      topicTitle: 'Knowing Our Numbers', subtopics: [], keyTerms: ['place value', 'digits'],
    });
    expect(result).toEqual([]);
  });

  test('a Qdrant failure returns [] rather than throwing', async () => {
    mockScroll.mockRejectedValueOnce(new Error('timeout'));
    const result = await findTopicImages({ grade: 6, subject: 'Science', topicTitle: 'Food Web' });
    expect(result).toEqual([]);
  });
});
