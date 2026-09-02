// Unit tests for services/qdrant.js's listSubjects()/listSyllabus() — B01
// (Aivorah_Teacher_Defect_Tracker): raw PDF-code placeholders like "bemr101"
// that end up in a Qdrant point's `topic` payload must never be surfaced to
// the teacher as a topic-suggestion chip. topicsByPdfFile() already filtered
// these out via looksLikeRealTopicName() (Bug #6) — listSubjects()/
// listSyllabus() did not apply the same filter, which is what let a raw code
// reach the Upload & Classify screen's topic chips.

const mockScroll = jest.fn();
jest.mock('@qdrant/js-client-rest', () => ({
  QdrantClient: jest.fn().mockImplementation(() => ({ scroll: (...args) => mockScroll(...args) })),
}));

const { listSubjects, listSyllabus } = require('../../services/qdrant');

beforeEach(() => {
  jest.clearAllMocks();
});

describe('listSubjects', () => {
  test('raw PDF-code placeholders (Bug #6-style garbage) are excluded from topic chips', async () => {
    mockScroll.mockResolvedValueOnce({
      points: [
        { payload: { curriculum: 'IB PYP', grade: 'Grade 2', subject: 'English', topic: 'bemr101' } },
        { payload: { curriculum: 'IB PYP', grade: 'Grade 2', subject: 'English', topic: 'Action Words (Verbs)' } },
      ],
      next_page_offset: null,
    });
    const result = await listSubjects('IB PYP', 'Grade 2');
    const english = result.find((s) => s.subject === 'English');
    const topicNames = english.topics.map((t) => t.topic);
    expect(topicNames).not.toContain('bemr101');
    expect(topicNames).toContain('Action Words (Verbs)');
  });

  test('image-caption chunks are excluded (not real topic names)', async () => {
    mockScroll.mockResolvedValueOnce({
      points: [{ payload: { curriculum: 'IB PYP', grade: 'Grade 2', subject: 'Science', topic: 'This image depicts a cell' } }],
      next_page_offset: null,
    });
    const result = await listSubjects('IB PYP', 'Grade 2');
    const science = result.find((s) => s.subject === 'Science');
    expect(science.topics).toEqual([]);
  });
});

describe('listSyllabus', () => {
  test('raw PDF-code placeholders are excluded from the syllabus topic tree', async () => {
    mockScroll.mockResolvedValueOnce({
      points: [
        { payload: { curriculum: 'IB PYP', grade: 'Grade 2', subject: 'English', chapter: 1, topic: 'bemr101' } },
        { payload: { curriculum: 'IB PYP', grade: 'Grade 2', subject: 'English', chapter: 1, topic: 'Comprehension Skills' } },
      ],
      next_page_offset: null,
    });
    const result = await listSyllabus('IB PYP', 'Grade 2', 'English');
    const topicNames = result[0].topics.map((t) => t.name);
    expect(topicNames).not.toContain('bemr101');
    expect(topicNames).toContain('Comprehension Skills');
  });
});
