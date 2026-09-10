// Unit tests for services/qdrant.js's resolveTopicContent() — Bug #8
// (BUGS_AND_FIXES.md): resolves real lesson content for a topic that only
// exists in Qdrant (no syllabus_topics DB row), by curriculum+grade+subject+
// topic name.

const mockScroll = jest.fn();
jest.mock('@qdrant/js-client-rest', () => ({
  QdrantClient: jest.fn().mockImplementation(() => ({ scroll: (...args) => mockScroll(...args) })),
}));

const { resolveTopicContent, toQdrantCurriculum } = require('../../services/qdrant');

beforeEach(() => {
  jest.clearAllMocks();
});

describe('resolveTopicContent', () => {
  test('missing any required arg -> null, no Qdrant call', async () => {
    expect(await resolveTopicContent('NCERT', 'Grade 9', 'English', '')).toBeNull();
    expect(mockScroll).not.toHaveBeenCalled();
  });

  test('no matching points -> null', async () => {
    mockScroll.mockResolvedValueOnce({ points: [], next_page_offset: null });
    const result = await resolveTopicContent('NCERT', 'Grade 9', 'English', 'Ability Beyond Disability');
    expect(result).toBeNull();
  });

  test('real text chunks are ordered by chunk_index and joined into intro + body', async () => {
    mockScroll.mockResolvedValueOnce({
      points: [
        { payload: { content_type: 'semantic_chunk', chunk_index: 1, text: 'Second part.', source_reference: 'NCERT English Grade 9 | iebe105.pdf' } },
        { payload: { content_type: 'semantic_chunk', chunk_index: 0, text: 'Ability Beyond Disability — intro.', source_reference: 'NCERT English Grade 9 | iebe105.pdf' } },
      ],
      next_page_offset: null,
    });
    const result = await resolveTopicContent('NCERT', 9, 'English', 'Ability Beyond Disability');
    expect(result.intro).toBe('Ability Beyond Disability — intro.');
    expect(result.body).toEqual(['Second part.']);
    expect(result.sourceReference).toBe('NCERT English Grade 9 | iebe105.pdf');
  });

  // S04: ingest-all-ncert.js / ocr-ingest.cjs (the bulk NCERT chunker used to
  // remediate the Hindi mojibake bug) store chunk text under `content`, not
  // `text` — a pre-existing field-name mismatch with the richer micro-topic
  // pipeline this resolver was originally written against. Real content was
  // sitting in Qdrant, correctly tagged, but resolveTopicContent returned
  // null (COMING_SOON) for every chapter ingested via the bulk chunker,
  // regardless of subject/language — not Hindi-specific.
  test('real text is found under `content` too, not only `text` (bulk-chunker payload shape)', async () => {
    mockScroll.mockResolvedValueOnce({
      points: [
        { payload: { content_type: 'explanation', chunk_index: 0, content: 'चित्र और बातचीत — असली पाठ।', source: 'ncert_books/grade2/hindi/bhsr101.pdf' } },
      ],
      next_page_offset: null,
    });
    const result = await resolveTopicContent('NCERT', 2, 'Hindi', 'चित्र और बातचीत');
    expect(result).not.toBeNull();
    expect(result.intro).toBe('चित्र और बातचीत — असली पाठ।');
  });

  test('image-caption chunks are excluded from text content, included as images', async () => {
    mockScroll.mockResolvedValueOnce({
      points: [
        { payload: { content_type: 'semantic_chunk', chunk_index: 0, text: 'Real lesson text.' } },
        { payload: { content_type: 'image', text: 'This image depicts a diagram.', image_url: 'https://cdn.example/img.jpg' } },
      ],
      next_page_offset: null,
    });
    const result = await resolveTopicContent('NCERT', 9, 'Science', 'Some Topic');
    expect(result.intro).toBe('Real lesson text.');
    expect(result.body).toEqual([]);
    expect(result.images).toEqual([{ url: 'https://cdn.example/img.jpg', description: 'This image depicts a diagram.' }]);
  });

  // Regression: BookPane.tsx's "View in Book" pane only renders when
  // topic.pdfFile is set, but resolveTopicContent() never returned one — the
  // real textbook silently never appeared for any Qdrant-only topic, even
  // when the simplified explanation loaded fine. See BUGS_AND_FIXES.md,
  // Bug #11 sixth finding.
  test('extracts pdfFile from the first point\'s source_reference for the "View in Book" pane', async () => {
    mockScroll.mockResolvedValueOnce({
      points: [
        { payload: { content_type: 'semantic_chunk', chunk_index: 0, text: 'Transaction in Accounting — intro.', source_reference: 'NCERT Accountancy Grade 11 | keac101.pdf' } },
      ],
      next_page_offset: null,
    });
    const result = await resolveTopicContent('NCERT', 'Grade 11', 'Accountancy', 'Transaction in Accounting');
    expect(result.pdfFile).toBe('keac101.pdf');
  });

  test('no extractable pdf filename in either source field -> pdfFile is null, not fabricated', async () => {
    mockScroll.mockResolvedValueOnce({
      points: [
        { payload: { content_type: 'semantic_chunk', chunk_index: 0, text: 'Some text.' } },
      ],
      next_page_offset: null,
    });
    const result = await resolveTopicContent('NCERT', 9, 'English', 'X');
    expect(result.pdfFile).toBeNull();
  });

  test('a Qdrant hiccup propagates as a rejection, not a silent wrong answer', async () => {
    mockScroll.mockRejectedValueOnce(new Error('Qdrant down'));
    await expect(resolveTopicContent('NCERT', 9, 'English', 'X')).rejects.toThrow('Qdrant down');
  });

  // Regression: the real frontend always sends curriculum="CBSE" (see
  // /topic-by-name/resources's caller, SubjectSyllabusScreen.tsx) — Qdrant's
  // NCERT_COLLECTION tags the same content "NCERT" instead. Every earlier
  // manual/unit test of this function passed "NCERT" directly, which masked
  // this for three fix attempts (BUGS_AND_FIXES.md, Bug #11 fifth finding) —
  // confirmed live via curl that curriculum=CBSE returned zero points.
  describe('toQdrantCurriculum', () => {
    test('maps CBSE (any case) to NCERT', () => {
      expect(toQdrantCurriculum('CBSE')).toBe('NCERT');
      expect(toQdrantCurriculum('cbse')).toBe('NCERT');
      expect(toQdrantCurriculum(' Cbse ')).toBe('NCERT');
    });

    test('leaves other curricula untouched', () => {
      expect(toQdrantCurriculum('NCERT')).toBe('NCERT');
      expect(toQdrantCurriculum('IB PYP')).toBe('IB PYP');
    });
  });

  test('a real curriculum="CBSE" call (what the frontend actually sends) queries Qdrant for "NCERT", not "CBSE"', async () => {
    mockScroll.mockResolvedValueOnce({
      points: [{ payload: { content_type: 'semantic_chunk', chunk_index: 0, text: 'Transaction in Accounting — intro.', source_reference: 'NCERT Accountancy Grade 11' } }],
      next_page_offset: null,
    });
    const result = await resolveTopicContent('CBSE', 'Grade 11', 'Accountancy', 'Transaction in Accounting');
    expect(result.intro).toBe('Transaction in Accounting — intro.');
    const filterArg = mockScroll.mock.calls[0][1].filter;
    const curriculumClause = filterArg.must.find(c => c.key === 'curriculum');
    expect(curriculumClause.match.value).toBe('NCERT');
  });
});
