// Unit tests for services/qdrant.js's topicsByPdfFile() — Bug #11
// (BUGS_AND_FIXES.md) and its follow-up: which real topics have been
// ingested for a curriculum+grade+subject, grouped by source PDF file.
// Used both to correct the "pending"/"Coming Soon" flag AND to fill in a
// not-pending chapter's `topics` list (previously stayed "0 topics" because
// syllabus_topics — the DB table `chapter.topics` used to come from
// exclusively — is empty for virtually all NCERT content). Queries
// NCERT_COLLECTION directly — NOT listSyllabus()/IB_COLLECTION, which has
// no NCERT content in it — an earlier version of this fix mistakenly called
// that and silently returned nothing for every NCERT subject.
//
// Grouped/matched by PDF filename, not chapter number: real Qdrant points
// have no reliable numeric `chapter` field, but every point's source PDF
// filename is present, in one of two payload fields depending on ingestion
// batch: `source` ("ncert_books/grade9/english/iemr101.pdf") or
// `source_reference` ("NCERT English Grade 9 | iebe105.pdf | Page 22").

const mockScroll = jest.fn();
jest.mock('@qdrant/js-client-rest', () => ({
  QdrantClient: jest.fn().mockImplementation(() => ({ scroll: (...args) => mockScroll(...args) })),
}));

const { topicsByPdfFile } = require('../../services/qdrant');

beforeEach(() => {
  jest.clearAllMocks();
});

describe('topicsByPdfFile', () => {
  test('missing any required arg -> empty Map, no Qdrant call', async () => {
    const result = await topicsByPdfFile('NCERT', 'Grade 9', '');
    expect(result).toEqual(new Map());
    expect(mockScroll).not.toHaveBeenCalled();
  });

  test('real topics grouped by their source PDF file', async () => {
    mockScroll.mockResolvedValueOnce({
      points: [
        { payload: { source: 'ncert_books/grade9/english/iebe105.pdf', topic: 'Ability Beyond Disability' } },
        { payload: { source_reference: 'NCERT English Grade 9 | iebe105.pdf | Page 2', topic: 'Ability Beyond Disability' } }, // dup
        { payload: { source_reference: 'NCERT English Grade 9 | iebe107.pdf', topic: 'A Different Topic' } },
      ],
      next_page_offset: null,
    });
    const result = await topicsByPdfFile('NCERT', 'Grade 9', 'English');
    expect([...result.keys()]).toEqual(expect.arrayContaining(['iebe105.pdf', 'iebe107.pdf']));
    expect(result.get('iebe105.pdf')).toHaveLength(1); // deduped
    expect(result.get('iebe105.pdf')[0]).toEqual(expect.objectContaining({ name: 'Ability Beyond Disability', kind: 'qdrant' }));
  });

  test('image-caption chunks are excluded (not real topic names)', async () => {
    mockScroll.mockResolvedValueOnce({
      points: [{ payload: { source: 'x/iesc101.pdf', topic: 'This image depicts a diagram of a cell' } }],
      next_page_offset: null,
    });
    const result = await topicsByPdfFile('NCERT', 'Grade 9', 'Science');
    expect(result.size).toBe(0);
  });

  test('raw PDF-code placeholders (Bug #6-style garbage) are excluded', async () => {
    mockScroll.mockResolvedValueOnce({
      points: [{ payload: { source: 'x/iemr101.pdf', topic: 'iemr101' } }],
      next_page_offset: null,
    });
    const result = await topicsByPdfFile('NCERT', 'Grade 9', 'English');
    expect(result.size).toBe(0);
  });

  test('nothing ingested for this subject -> empty Map, not an error', async () => {
    mockScroll.mockResolvedValueOnce({ points: [], next_page_offset: null });
    const result = await topicsByPdfFile('NCERT', 'Grade 9', 'French');
    expect(result).toEqual(new Map());
  });
});
