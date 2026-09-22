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

  // Confirmed via live query comparison against the monolith: Qdrant stores
  // IB PYP content under curriculum "IB_PYP" (underscore), not "IB PYP" (the
  // display name every caller passes in) — querying with the un-translated
  // name silently returned zero results (0 subjects instead of the real 7).
  test('"IB PYP" (display name) is translated to "IB_PYP" for the actual Qdrant match', async () => {
    mockScroll.mockResolvedValueOnce({ points: [], next_page_offset: null });
    await listSubjects('IB PYP', 'Grade 3');
    expect(mockScroll).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({
        filter: expect.objectContaining({
          must: expect.arrayContaining([{ key: 'curriculum', match: { value: 'IB_PYP' } }]),
        }),
      })
    );
  });

  test('other curricula (e.g. Cambridge) are queried under their plain display name, unchanged', async () => {
    mockScroll.mockResolvedValueOnce({ points: [], next_page_offset: null });
    await listSubjects('Cambridge', 'Grade 3');
    expect(mockScroll).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({
        filter: expect.objectContaining({
          must: expect.arrayContaining([{ key: 'curriculum', match: { value: 'Cambridge' } }]),
        }),
      })
    );
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
