// Unit tests for routes/syllabus.js — GET /current, GET /topic/:topicId/resources.
// Supabase and the syllabus-map/resourceResolver services are mocked.

jest.mock('../../services/supabase', () => {
  const chain = {
    select: jest.fn().mockReturnThis(),
    match: jest.fn().mockReturnThis(),
    in: jest.fn().mockReturnThis(),
    order: jest.fn(),
  };
  return { from: jest.fn(() => chain), _chain: chain };
});

const mockChaptersFor = jest.fn();
jest.mock('../../services/syllabus-map', () => ({
  chaptersFor: (...args) => mockChaptersFor(...args),
}));

const mockResolveAllResources = jest.fn();
const mockResolveResourcesByTopicName = jest.fn();
jest.mock('../../services/curriculum/resourceResolver', () => ({
  resolveAllResources: (...args) => mockResolveAllResources(...args),
  resolveResourcesByTopicName: (...args) => mockResolveResourcesByTopicName(...args),
}));

const mockTopicsByPdfFile = jest.fn();
jest.mock('../../services/qdrant', () => ({
  topicsByPdfFile: (...args) => mockTopicsByPdfFile(...args),
}));

// AI enrichment pilot (see routes/syllabus.js's topic-by-name/resources
// handler) is mocked to return null (= "no enrichment available") by
// default, so these pre-existing tests never make a real Groq/Supabase call
// and their exact response-body assertions stay unaffected.
process.env.ENRICH_WAIT_MS = '60';
const mockGetOrGenerateEnrichment = jest.fn();
const mockGetCachedEnrichment = jest.fn();
jest.mock('../../services/curriculum/enrichment', () => ({
  getOrGenerateEnrichment: (...args) => mockGetOrGenerateEnrichment(...args),
  getCachedEnrichment: (...args) => mockGetCachedEnrichment(...args),
}));

const mockMathTutorForTopic = jest.fn();
jest.mock('../../services/curriculum/mathTutorSections', () => ({
  mathTutorForTopic: (...args) => mockMathTutorForTopic(...args),
}));

const mockUnitContentForTopic = jest.fn();
jest.mock('../../services/curriculum/unitContentSections', () => ({
  unitContentForTopic: (...args) => mockUnitContentForTopic(...args),
  learnWithVisuals: (learn) => learn,
}));

const mockSectionsByPdf = jest.fn();
const mockSectionByTitle = jest.fn();
jest.mock('../../services/curriculum/bookSections', () => ({
  sectionsByPdf: (...args) => mockSectionsByPdf(...args),
  sectionByTitle: (...args) => mockSectionByTitle(...args),
}));

const express = require('express');
const request = require('supertest');
const supabase = require('../../services/supabase');
const syllabusRoute = require('../../routes/syllabus');

const app = express();
app.use(express.json());
app.use('/teacher/syllabus', syllabusRoute);

beforeEach(() => {
  jest.clearAllMocks();
  mockChaptersFor.mockReturnValue([]); // no book-chapter map by default, so `live` chapters pass through as-is
  mockTopicsByPdfFile.mockResolvedValue(new Map()); // no Qdrant content by default
  mockMathTutorForTopic.mockResolvedValue(null);
  mockUnitContentForTopic.mockResolvedValue(null);
  mockSectionsByPdf.mockResolvedValue(new Map());
  mockSectionByTitle.mockResolvedValue(null);
});

describe('GET /teacher/syllabus/current', () => {
  test('no chapters at all -> empty units list, no crash', async () => {
    supabase._chain.order.mockResolvedValueOnce({ data: [], error: null });

    const res = await request(app).get('/teacher/syllabus/current').query({ grade: 'Grade 4', subject: 'Mathematics' });

    expect(res.status).toBe(200);
    expect(res.body.units).toEqual([]);
  });

  test('a unit whose book sections are built lists those real sections as topics, and loses a Chapter N placeholder name', async () => {
    supabase._chain.order.mockResolvedValueOnce({ data: [], error: null });
    mockChaptersFor.mockReturnValue([{ chapter: 1, title: 'Chapter 1', pdfFile: 'hhbk101.pdf', bookPath: 'grade8/hindi/hhbk101.pdf', subtopics: [] }]);
    mockTopicsByPdfFile.mockResolvedValue(new Map([['hhbk101.pdf', [{ name: 'संज्ञा के भेद' }]]]));
    mockSectionsByPdf.mockResolvedValue(new Map([['hhbk101.pdf', [{ no: 1, title: 'अहमदनगर का किला', page: 1 }, { no: 2, title: 'अतीत का भार', page: 2 }]]]));

    const res = await request(app).get('/teacher/syllabus/current').query({ grade: 'Grade 8', subject: 'Hindi' });
    const u = res.body.units[0];
    expect(u.title).toBe('अहमदनगर का किला');
    expect(u.topics).toEqual([{ name: 'अहमदनगर का किला', kind: 'section', page: 1 }, { name: 'अतीत का भार', kind: 'section', page: 2 }]);
    expect(u.pending).toBe(false);
  });

  test('chapters with no topics still appear (not silently dropped)', async () => {
    supabase._chain.order
      .mockResolvedValueOnce({ data: [{ id: 'c1', unit_no: 1, title: 'Fractions' }], error: null }) // chapters query
      .mockResolvedValueOnce({ data: [], error: null }); // topics query (chapterIds.length > 0, so goes through .in().order())

    const res = await request(app).get('/teacher/syllabus/current').query({ grade: 'Grade 4', subject: 'Mathematics' });

    expect(res.status).toBe(200);
    expect(res.body.units).toEqual([
      { unitNo: 1, title: 'Fractions', topics: [] },
    ]);
  });

  test('a chapter WITH topics returns them nested under it, ordered', async () => {
    supabase._chain.order
      .mockResolvedValueOnce({ data: [{ id: 'c1', unit_no: 1, title: 'Fractions' }], error: null })
      .mockResolvedValueOnce({
        data: [{ id: 't1', chapter_id: 'c1', topic_order: 1, name: 'Halves', kind: 'lesson', page: 'p.1' }],
        error: null,
      });

    const res = await request(app).get('/teacher/syllabus/current').query({ grade: 'Grade 4', subject: 'Mathematics' });

    expect(res.body.units[0].topics).toEqual([{ id: 't1', name: 'Halves', kind: 'lesson', page: 'p.1' }]);
  });

  test('when the syllabus map throws, falls back gracefully to the live chapters (no 500)', async () => {
    supabase._chain.order.mockResolvedValueOnce({ data: [{ id: 'c1', unit_no: 1, title: 'Fractions' }], error: null })
      .mockResolvedValueOnce({ data: [], error: null });
    mockChaptersFor.mockImplementation(() => { throw new Error('map file missing'); });

    const res = await request(app).get('/teacher/syllabus/current').query({ grade: 'Grade 4', subject: 'Mathematics' });

    expect(res.status).toBe(200);
    expect(res.body.units).toHaveLength(1);
  });

  test('a book chapter with no matching live row appears as pending (greyed out, not dropped)', async () => {
    supabase._chain.order.mockResolvedValueOnce({ data: [], error: null });
    mockChaptersFor.mockReturnValue([
      { chapter: 1, title: 'Whole Numbers', bookPath: '/book/1', subtopics: [] },
    ]);

    const res = await request(app).get('/teacher/syllabus/current').query({ grade: 'Grade 6', subject: 'Mathematics' });

    expect(res.body.units).toEqual([
      expect.objectContaining({ unitNo: 1, title: 'Whole Numbers', pending: true, topics: [] }),
    ]);
  });

  test('a live chapter matched to a book chapter by TITLE (not just number) keeps its real topics', async () => {
    supabase._chain.order
      .mockResolvedValueOnce({ data: [{ id: 'c1', unit_no: 1, title: 'Fractions' }], error: null })
      .mockResolvedValueOnce({ data: [{ id: 't1', chapter_id: 'c1', topic_order: 1, name: 'Halves', kind: 'lesson', page: 'p.1' }], error: null });
    // Book map has "Fractions" at a DIFFERENT chapter number (2) — title match should still find it.
    mockChaptersFor.mockReturnValue([{ chapter: 2, title: 'Fractions', bookPath: '/book/2', subtopics: [] }]);

    const res = await request(app).get('/teacher/syllabus/current').query({ grade: 'Grade 4', subject: 'Mathematics' });

    expect(res.body.units).toEqual([
      expect.objectContaining({ unitNo: 2, title: 'Fractions', pending: false, topics: [{ id: 't1', name: 'Halves', kind: 'lesson', page: 'p.1' }] }),
    ]);
  });

  test('a schoolId query param is passed through to the Supabase filter (B2B tenant scoping)', async () => {
    supabase._chain.order.mockResolvedValueOnce({ data: [], error: null });

    await request(app).get('/teacher/syllabus/current').query({ grade: 'Grade 4', subject: 'Mathematics', schoolId: 'school-42' });

    expect(supabase._chain.match).toHaveBeenCalledWith(
      expect.objectContaining({ school_id: 'school-42' })
    );
  });

  test('no schoolId query param -> the filter omits school_id entirely (not sent as undefined)', async () => {
    supabase._chain.order.mockResolvedValueOnce({ data: [], error: null });

    await request(app).get('/teacher/syllabus/current').query({ grade: 'Grade 4', subject: 'Mathematics' });

    const filterArg = supabase._chain.match.mock.calls[0][0];
    expect(filterArg).not.toHaveProperty('school_id');
  });

  test('two multi-volume book chapters sharing the same real title are de-duplicated to one unit', async () => {
    supabase._chain.order.mockResolvedValueOnce({ data: [], error: null });
    // Two different volumes, same title "Reading Comprehension" — both real titles, not placeholders.
    mockChaptersFor.mockReturnValue([
      { chapter: 1, title: 'Reading Comprehension', bookPath: '/vol1/1', subtopics: [] },
      { chapter: 1, title: 'Reading Comprehension', bookPath: '/vol2/1', subtopics: [] }, // repeats chapter number
    ]);

    const res = await request(app).get('/teacher/syllabus/current').query({ grade: 'Grade 8', subject: 'English' });

    expect(res.body.units).toHaveLength(1);
    expect(res.body.units[0].title).toBe('Reading Comprehension');
  });

  // S04: a single real primer (Grade 2 Hindi, cbse-g2-hindi-bhsr1) has 25
  // genuinely distinct chapters, several of which legitimately share a
  // recurring section-type label ("आनंदमयी कविता" = "Joyful Poem", used for 6
  // different actual poems). These have DIFFERENT chapter numbers (not the
  // multi-volume-restart-numbering case above, which always collides on
  // number too) — the title-based dedupe was incorrectly treating "same
  // label" as "same content" and silently dropping 14 of 25 real chapters.
  test('distinct chapters within ONE book that legitimately share a recurring section title are NOT collapsed', async () => {
    supabase._chain.order.mockResolvedValueOnce({ data: [], error: null });
    mockChaptersFor.mockReturnValue([
      { chapter: 2, title: 'आनंदमयी कविता', bookPath: '/g2/hindi/bhsr102.pdf', subtopics: [] },
      { chapter: 4, title: 'आनंदमयी कविता', bookPath: '/g2/hindi/bhsr104.pdf', subtopics: [] },
      { chapter: 9, title: 'आनंदमयी कविता', bookPath: '/g2/hindi/bhsr109.pdf', subtopics: [] },
    ]);

    const res = await request(app).get('/teacher/syllabus/current').query({ grade: 'Grade 2', subject: 'Hindi' });

    expect(res.body.units).toHaveLength(3);
    expect(res.body.units.map((u) => u.unitNo).sort()).toEqual([2, 4, 9]);
  });

  test('a leftover DB row whose title is still "Chapter N" gets folded into the matching mapped chapter, not shown as a duplicate', async () => {
    // Live DB has a real mapped chapter (unit 1, title "Sets") AND a legacy leftover
    // row at the same unit number whose title was never migrated past "Chapter 1".
    supabase._chain.order
      .mockResolvedValueOnce({
        data: [
          { id: 'c1', unit_no: 1, title: 'Sets' },
          { id: 'c2', unit_no: 1, title: 'Chapter 1' },
        ],
        error: null,
      })
      .mockResolvedValueOnce({
        data: [
          { id: 't1', chapter_id: 'c1', topic_order: 1, name: 'Set operations', kind: 'lesson', page: 'p.1' },
          { id: 't2', chapter_id: 'c2', topic_order: 1, name: 'Leftover topic', kind: 'lesson', page: 'p.9' },
        ],
        error: null,
      });
    mockChaptersFor.mockReturnValue([{ chapter: 1, title: 'Sets', bookPath: '/book/1', subtopics: [] }]);

    const res = await request(app).get('/teacher/syllabus/current').query({ grade: 'Grade 11', subject: 'Mathematics' });

    // Only ONE unit for chapter 1 — the placeholder row's topic is merged in, not a second accordion.
    expect(res.body.units).toHaveLength(1);
    expect(res.body.units[0].topics.map(t => t.name)).toEqual(
      expect.arrayContaining(['Set operations', 'Leftover topic'])
    );
  });

  test('a book chapter with real subtopics maps them to their titles', async () => {
    supabase._chain.order.mockResolvedValueOnce({ data: [], error: null });
    mockChaptersFor.mockReturnValue([
      {
        chapter: 1, title: 'Sets', bookPath: '/book/1',
        subtopics: [{ title: 'Set operations' }, { title: 'Venn diagrams' }],
      },
    ]);

    const res = await request(app).get('/teacher/syllabus/current').query({ grade: 'Grade 11', subject: 'Mathematics' });

    expect(res.body.units[0].subtopics).toEqual(['Set operations', 'Venn diagrams']);
  });

  test('a live DB chapter that matches no book chapter at all (by title or number) still appears, marked unmapped', async () => {
    supabase._chain.order.mockResolvedValueOnce({ data: [{ id: 'c9', unit_no: 9, title: 'A Locally-Added Chapter' }], error: null })
      .mockResolvedValueOnce({
        data: [{ id: 't9', chapter_id: 'c9', topic_order: 1, name: 'Some topic', kind: 'lesson', page: 'p.1' }],
        error: null,
      });
    // Book map has a totally different chapter — number 1, different title — no match for unit 9.
    mockChaptersFor.mockReturnValue([{ chapter: 1, title: 'Sets', bookPath: '/book/1', subtopics: [] }]);

    const res = await request(app).get('/teacher/syllabus/current').query({ grade: 'Grade 11', subject: 'Mathematics' });

    const unmappedUnit = res.body.units.find(u => u.unitNo === 9);
    expect(unmappedUnit).toEqual(expect.objectContaining({
      title: 'A Locally-Added Chapter', pending: false, unmapped: true,
    }));
  });

  // Bug #11 (BUGS_AND_FIXES.md): pending used to be computed only from
  // syllabus_topics (empty for NCERT), so a chapter with real content already
  // in Qdrant still showed "Coming Soon". Cross-check against Qdrant fixes
  // it — matched by PDF filename (Qdrant points have no reliable numeric
  // chapter field; an earlier version of this fix assumed one existed and
  // always returned an empty set).
  describe('pending reflects real Qdrant content (Bug #11)', () => {
    test('a chapter with no live DB topics but real Qdrant content (matched by pdfFile) is NOT pending, and topics are populated', async () => {
      supabase._chain.order.mockResolvedValueOnce({ data: [], error: null });
      mockChaptersFor.mockReturnValue([
        { chapter: 1, title: 'Real Numbers', pdfFile: 'iemh101.pdf', bookPath: '/book/1', subtopics: [] },
      ]);
      mockTopicsByPdfFile.mockResolvedValueOnce(new Map([
        ['iemh101.pdf', [{ id: 'qdrant:NCERT:9:Mathematics:Irrational Numbers', name: 'Irrational Numbers', kind: 'qdrant', page: '' }]],
      ]));

      const res = await request(app).get('/teacher/syllabus/current').query({ grade: 'Grade 9', subject: 'Mathematics', curriculum: 'CBSE' });

      expect(res.body.units[0]).toEqual(expect.objectContaining({ unitNo: 1, pending: false }));
      expect(res.body.units[0].topics).toEqual([
        { id: 'qdrant:NCERT:9:Mathematics:Irrational Numbers', name: 'Irrational Numbers', kind: 'qdrant', page: '' },
      ]);
      // The route passes curriculum through unmodified now — CBSE->NCERT
      // mapping moved down into services/qdrant.js's toQdrantCurriculum(),
      // applied inside topicsByPdfFile() itself (see qdrant-
      // resolveTopicContent.unit.test.js), so every NCERT_COLLECTION query
      // is protected at the source rather than each route remembering to map.
      expect(mockTopicsByPdfFile).toHaveBeenCalledWith('CBSE', 'Grade 9', 'Mathematics');
    });

    test('real DB topics (teacher-uploaded) take priority over Qdrant topics when both exist', async () => {
      supabase._chain.order
        .mockResolvedValueOnce({ data: [{ id: 'c1', unit_no: 1, title: 'Real Numbers' }], error: null })
        .mockResolvedValueOnce({ data: [{ id: 't1', chapter_id: 'c1', topic_order: 1, name: 'DB Topic', kind: 'lesson', page: 'p.1' }], error: null });
      mockChaptersFor.mockReturnValue([
        { chapter: 1, title: 'Real Numbers', pdfFile: 'iemh101.pdf', bookPath: '/book/1', subtopics: [] },
      ]);
      mockTopicsByPdfFile.mockResolvedValueOnce(new Map([
        ['iemh101.pdf', [{ id: 'qdrant:x', name: 'Qdrant Topic', kind: 'qdrant', page: '' }]],
      ]));

      const res = await request(app).get('/teacher/syllabus/current').query({ grade: 'Grade 9', subject: 'Mathematics', curriculum: 'CBSE' });

      expect(res.body.units[0].topics.map(t => t.name)).toEqual(['DB Topic']);
    });

    test('a chapter with no live DB topics AND no Qdrant content is genuinely pending, with an empty topics list', async () => {
      supabase._chain.order.mockResolvedValueOnce({ data: [], error: null });
      mockChaptersFor.mockReturnValue([
        { chapter: 2, title: 'Polynomials', pdfFile: 'iemh102.pdf', bookPath: '/book/2', subtopics: [] },
      ]);
      mockTopicsByPdfFile.mockResolvedValueOnce(new Map([['iemh101.pdf', [{ id: 'x', name: 'x', kind: 'qdrant', page: '' }]]])); // a different chapter's file has content, not this one

      const res = await request(app).get('/teacher/syllabus/current').query({ grade: 'Grade 9', subject: 'Mathematics', curriculum: 'CBSE' });

      expect(res.body.units[0]).toEqual(expect.objectContaining({ unitNo: 2, pending: true, topics: [] }));
    });

    test('a non-CBSE curriculum is passed through to Qdrant unchanged', async () => {
      supabase._chain.order.mockResolvedValueOnce({ data: [], error: null });
      mockChaptersFor.mockReturnValue([]);

      await request(app).get('/teacher/syllabus/current').query({ grade: 'Grade 9', subject: 'Mathematics', curriculum: 'IB DP' });

      expect(mockTopicsByPdfFile).toHaveBeenCalledWith('IB DP', 'Grade 9', 'Mathematics');
    });

    test('a Qdrant hiccup falls back to the old DB-only pending logic, no 500', async () => {
      supabase._chain.order.mockResolvedValueOnce({ data: [], error: null });
      mockChaptersFor.mockReturnValue([
        { chapter: 1, title: 'Real Numbers', pdfFile: 'iemh101.pdf', bookPath: '/book/1', subtopics: [] },
      ]);
      mockTopicsByPdfFile.mockRejectedValueOnce(new Error('Qdrant down'));

      const res = await request(app).get('/teacher/syllabus/current').query({ grade: 'Grade 9', subject: 'Mathematics', curriculum: 'CBSE' });

      expect(res.status).toBe(200);
      expect(res.body.units[0]).toEqual(expect.objectContaining({ unitNo: 1, pending: true }));
    });
  });
});

describe('GET /teacher/syllabus/topic/:topicId/resources', () => {
  test('success -> returns resolved resources', async () => {
    mockResolveAllResources.mockResolvedValueOnce({ read: {}, listen: {}, practice: {} });

    const res = await request(app).get('/teacher/syllabus/topic/topic-1/resources');

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true, topicId: 'topic-1', resources: { read: {}, listen: {}, practice: {} } });
    expect(mockResolveAllResources).toHaveBeenCalledWith({ topicId: 'topic-1' });
  });

  test('a resolver failure -> 500 with a generic error, no internals leaked', async () => {
    mockResolveAllResources.mockRejectedValueOnce(new Error('Supabase connection string invalid: postgres://user:pass@host'));

    const res = await request(app).get('/teacher/syllabus/topic/topic-1/resources');

    expect(res.status).toBe(500);
    expect(res.body.error).toBe('Could not resolve topic resources.');
    expect(res.body.error).not.toContain('postgres://');
  });
});

describe('GET /teacher/syllabus/topic-by-name/resources (Bug #8)', () => {
  test('missing any required query param -> 400', async () => {
    const res = await request(app).get('/teacher/syllabus/topic-by-name/resources').query({ curriculum: 'NCERT', grade: 'Grade 9' });
    expect(res.status).toBe(400);
    expect(mockResolveResourcesByTopicName).not.toHaveBeenCalled();
  });

  test('success -> returns resolved resources, resolved by name not id', async () => {
    mockResolveResourcesByTopicName.mockResolvedValueOnce([{ resourceType: 'AI_EXPLANATION', status: 'READY' }]);

    const res = await request(app).get('/teacher/syllabus/topic-by-name/resources').query({
      curriculum: 'NCERT', grade: 'Grade 9', subject: 'English', topic: 'Ability Beyond Disability',
    });

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true, resources: [{ resourceType: 'AI_EXPLANATION', status: 'READY' }] });
    expect(mockResolveResourcesByTopicName).toHaveBeenCalledWith({
      curriculum: 'NCERT', grade: 'Grade 9', subject: 'English', topic: 'Ability Beyond Disability',
    });
  });

  // Regression: the real frontend always sends curriculum="CBSE" (see
  // SubjectSyllabusScreen.tsx) — this route must pass it through unmodified;
  // the CBSE->NCERT translation happens one layer down, inside
  // services/qdrant.js's toQdrantCurriculum(), not at this route (see
  // qdrant-resolveTopicContent.unit.test.js for that mapping's coverage).
  test('a real curriculum="CBSE" query (what the frontend actually sends) is passed through as-is to the resolver', async () => {
    mockResolveResourcesByTopicName.mockResolvedValueOnce([{ resourceType: 'AI_EXPLANATION', status: 'READY' }]);

    const res = await request(app).get('/teacher/syllabus/topic-by-name/resources').query({
      curriculum: 'CBSE', grade: 'Grade 11', subject: 'Accountancy', topic: 'Transaction in Accounting',
    });

    expect(res.status).toBe(200);
    expect(mockResolveResourcesByTopicName).toHaveBeenCalledWith({
      curriculum: 'CBSE', grade: 'Grade 11', subject: 'Accountancy', topic: 'Transaction in Accounting',
    });
  });

  test('a resolver failure -> 500 with a generic error, no internals leaked', async () => {
    mockResolveResourcesByTopicName.mockRejectedValueOnce(new Error('Qdrant connection refused at 10.0.0.5'));

    const res = await request(app).get('/teacher/syllabus/topic-by-name/resources').query({
      curriculum: 'NCERT', grade: 'Grade 9', subject: 'English', topic: 'X',
    });

    expect(res.status).toBe(500);
    expect(res.body.error).toBe('Could not resolve topic resources.');
    expect(res.body.error).not.toContain('10.0.0.5');
  });

  // AI enrichment pilot merge behavior (Learn tab left-side structured
  // content) — see routes/syllabus.js and services/curriculum/enrichment.js.
  describe('AI enrichment merge onto AI_EXPLANATION', () => {
    test('enrichment blocks/whatYoullLearn/contentType are merged onto the AI_EXPLANATION payload, existing fields preserved', async () => {
      mockResolveResourcesByTopicName.mockResolvedValueOnce([
        { resourceType: 'AI_EXPLANATION', status: 'READY', payload: { intro: 'raw intro text', body: [], pdfFile: 'keac101.pdf' } },
        { resourceType: 'IMAGES', status: 'COMING_SOON' },
      ]);
      mockGetOrGenerateEnrichment.mockResolvedValueOnce({
        whatYoullLearn: ['What relevant information means'],
        blocks: [{ type: 'explanation', text: 'Simplified explanation.' }],
        contentType: 'theory',
      });

      const res = await request(app).get('/teacher/syllabus/topic-by-name/resources').query({
        curriculum: 'CBSE', grade: 'Grade 11', subject: 'Accountancy', topic: 'Relevance of Information',
      });

      const explanation = res.body.resources.find((r) => r.resourceType === 'AI_EXPLANATION');
      expect(explanation.payload.intro).toBe('raw intro text'); // backward-compat field untouched
      expect(explanation.payload.pdfFile).toBe('keac101.pdf');
      expect(explanation.payload.blocks).toEqual([{ type: 'explanation', text: 'Simplified explanation.' }]);
      expect(explanation.payload.whatYoullLearn).toEqual(['What relevant information means']);
      expect(explanation.payload.contentType).toBe('theory');
    });

    // Regression: existing DB-backed/Grade-6 topics and any topic where
    // enrichment isn't available yet must render exactly as before this
    // pilot — no blocks field, no crash, no empty-section artifacts.
    test('no enrichment available -> AI_EXPLANATION payload is completely unchanged from the resolver', async () => {
      mockResolveResourcesByTopicName.mockResolvedValueOnce([
        { resourceType: 'AI_EXPLANATION', status: 'READY', payload: { intro: 'raw intro text', body: [] } },
      ]);
      mockGetOrGenerateEnrichment.mockResolvedValueOnce(null);

      const res = await request(app).get('/teacher/syllabus/topic-by-name/resources').query({
        curriculum: 'CBSE', grade: 'Grade 9', subject: 'English', topic: 'Ability Beyond Disability',
      });

      const explanation = res.body.resources.find((r) => r.resourceType === 'AI_EXPLANATION');
      expect(explanation.payload).toEqual({ intro: 'raw intro text', body: [] });
    });

    test('an enrichment failure (throws) never breaks the response — same as a resolver-level degrade', async () => {
      mockResolveResourcesByTopicName.mockResolvedValueOnce([
        { resourceType: 'AI_EXPLANATION', status: 'READY', payload: { intro: 'raw intro text', body: [] } },
      ]);
      mockGetOrGenerateEnrichment.mockRejectedValueOnce(new Error('Groq quota exceeded'));

      const res = await request(app).get('/teacher/syllabus/topic-by-name/resources').query({
        curriculum: 'CBSE', grade: 'Grade 11', subject: 'Accountancy', topic: 'Relevance of Information',
      });

      expect(res.status).toBe(200);
      const explanation = res.body.resources.find((r) => r.resourceType === 'AI_EXPLANATION');
      expect(explanation.payload).toEqual({ intro: 'raw intro text', body: [] });
    });

    test('a NOT-READY AI_EXPLANATION (e.g. COMING_SOON) never triggers an enrichment call', async () => {
      mockResolveResourcesByTopicName.mockResolvedValueOnce([
        { resourceType: 'AI_EXPLANATION', status: 'COMING_SOON', payload: null },
      ]);

      await request(app).get('/teacher/syllabus/topic-by-name/resources').query({
        curriculum: 'CBSE', grade: 'Grade 11', subject: 'Accountancy', topic: 'Nonexistent',
      });

      expect(mockGetOrGenerateEnrichment).not.toHaveBeenCalled();
    });
  });
});

describe('topic-by-name enrichment time budget', () => {
  const q = (topic) => ({ curriculum: 'NCERT', grade: 'Grade 8', subject: 'Science', topic });
  const ready = () => [{ resourceType: 'AI_EXPLANATION', status: 'READY', payload: { intro: 'plain text' } }];
  const get = (topic) => request(app).get('/teacher/syllabus/topic-by-name/resources').query(q(topic));

  beforeEach(() => {
    syllabusRoute.__resetEnrichState();
    mockGetCachedEnrichment.mockResolvedValue(null);
    mockResolveResourcesByTopicName.mockImplementation(async () => ready());
  });

  test('a slow AI generation does not hold the response: plain lesson comes back within the budget', async () => {
    let finishAi;
    mockGetOrGenerateEnrichment.mockImplementation(() => new Promise((resolve) => { finishAi = resolve; }));

    const res = await get('slow-topic'); // AI never finishes before this returns
    expect(res.status).toBe(200);
    expect(res.body.resources[0].payload).toEqual({ intro: 'plain text' });
    finishAi(null);
  });

  test('while the first opener is still waiting on the AI, the next student is not made to wait again', async () => {
    let finishAi;
    mockGetOrGenerateEnrichment.mockImplementation(() => new Promise((resolve) => { finishAi = resolve; }));

    await get('shared-topic'); // first opener: waits the budget then gets plain text
    const timers = jest.spyOn(global, 'setTimeout');
    const res = await get('shared-topic');
    const budgetWaits = timers.mock.calls.filter(([, ms]) => ms === Number(process.env.ENRICH_WAIT_MS));
    timers.mockRestore();
    expect(budgetWaits).toHaveLength(0);
    expect(res.body.resources[0].payload).toEqual({ intro: 'plain text' });
    expect(mockGetOrGenerateEnrichment).toHaveBeenCalledTimes(1);
    finishAi(null);
  });

  test('after a failed generation the same topic is not retried straight away', async () => {
    mockGetOrGenerateEnrichment.mockResolvedValue(null);

    await get('failing-topic');
    await get('failing-topic');
    expect(mockGetOrGenerateEnrichment).toHaveBeenCalledTimes(1);
  });

  test('a thrown AI error still returns the plain lesson', async () => {
    mockGetOrGenerateEnrichment.mockRejectedValue(new Error('groq exhausted'));

    const res = await get('throwing-topic');
    expect(res.status).toBe(200);
    expect(res.body.resources[0].payload).toEqual({ intro: 'plain text' });
  });

  test('a fast generation still returns the rich blocks', async () => {
    mockGetOrGenerateEnrichment.mockResolvedValue({ whatYoullLearn: ['a'], blocks: [{ type: 'table' }], contentType: 'theory' });

    const res = await get('fast-topic');
    expect(res.body.resources[0].payload.blocks).toEqual([{ type: 'table' }]);
  });

  test('a saved lesson with a target book page passes pdfPage through so the viewer opens there', async () => {
    mockGetOrGenerateEnrichment.mockResolvedValue({ whatYoullLearn: ['a'], blocks: [{ type: 'table' }], contentType: 'theory', pdfPage: 35 });

    const res = await get('paged-topic');
    expect(res.body.resources[0].payload.pdfPage).toBe(35);
  });

  test('a saved narration script is passed through for the Listen tab', async () => {
    const listenScript = [{ card: null, heading: 'Introduction', text: 'Hello.' }, { card: 0, heading: 'Action', text: 'First card.' }];
    mockGetOrGenerateEnrichment.mockResolvedValue({ whatYoullLearn: ['a'], blocks: [{ type: 'table' }], contentType: 'theory', listenScript });

    const res = await get('scripted-topic');
    expect(res.body.resources[0].payload.listenScript).toEqual(listenScript);
  });

  test('a saved Maths AI Tutor is passed through; an empty one is left out', async () => {
    const mathTutor = { examples: [{ problem: 'Find 7 squared.', steps: [{ say: 'Multiply 7 by 7.', show: '7 x 7 = 49' }], answer: '49' }] };
    mockGetOrGenerateEnrichment.mockResolvedValue({ whatYoullLearn: ['a'], blocks: [{ type: 'table' }], contentType: 'theory', mathTutor });
    let res = await get('tutor-topic');
    expect(res.body.resources[0].payload.mathTutor).toEqual(mathTutor);

    mockGetOrGenerateEnrichment.mockResolvedValue({ whatYoullLearn: ['a'], blocks: [{ type: 'table' }], contentType: 'theory', mathTutor: { examples: [] } });
    res = await get('no-tutor-topic');
    expect('mathTutor' in res.body.resources[0].payload).toBe(false);
  });

  test('a Maths topic without its own tutor gets its unit section tutor, and the book opens at that section', async () => {
    mockResolveResourcesByTopicName.mockResolvedValue([{ resourceType: 'AI_EXPLANATION', status: 'READY', payload: { intro: 'i', body: [], pdfFile: 'hegp101.pdf' } }]);
    mockGetOrGenerateEnrichment.mockResolvedValue(null);
    const examples = [{ problem: 'Consider √81.', steps: [{ say: 'Take away 1.', show: '81 − 1 = 80' }], answer: '9' }];
    mockMathTutorForTopic.mockResolvedValue({ intro: 'We learn square roots.', examples, section: '1.1 Square Numbers', pdfPage: 3 });

    const res = await request(app).get('/teacher/syllabus/topic-by-name/resources').query({ curriculum: 'CBSE', grade: 'Grade 8', subject: 'Mathematics', topic: 'Square Roots' });
    expect(mockMathTutorForTopic).toHaveBeenCalledWith('hegp101.pdf', 'Square Roots');
    expect(res.body.resources[0].payload.mathTutor).toEqual({ intro: 'We learn square roots.', examples, section: '1.1 Square Numbers' });
    expect(res.body.resources[0].payload.pdfPage).toBe(3);
  });

  test('a non-Maths topic with pre-built section content gets Learn, Listen and a quiz without waiting on a live LLM', async () => {
    mockResolveResourcesByTopicName.mockResolvedValue([{ resourceType: 'AI_EXPLANATION', status: 'READY', payload: { intro: 'i', body: [], pdfFile: 'hhbk101.pdf' } }]);
    mockGetCachedEnrichment.mockResolvedValue(null);
    const learn = { whatYoullLearn: ['a'], blocks: [{ type: 'overview', text: 'x' }] };
    const listen = [{ card: null, heading: 'h', text: 't', lines: [{ speaker: 'Narrator', text: 't', page: 1 }] }];
    const quiz = [{ question: 'q', options: ['a', 'b', 'c', 'd'], correctIndex: 0 }];
    mockUnitContentForTopic.mockResolvedValue({ section: 'S', pdfPage: 2, lang: 'hi', learn, listen, quiz });

    const res = await request(app).get('/teacher/syllabus/topic-by-name/resources').query({ curriculum: 'CBSE', grade: 'Grade 8', subject: 'Hindi', topic: 'Fort' });
    const p = res.body.resources[0].payload;
    expect(mockGetOrGenerateEnrichment).not.toHaveBeenCalled();
    expect(p.blocks).toEqual(learn.blocks);
    expect(p.listenScript).toEqual(listen);
    expect(p.practiceQuiz).toEqual(quiz);
    expect(p).toMatchObject({ pdfPage: 2, lang: 'hi', section: 'S' });
  });

  test('a saved topic lesson keeps priority over section content', async () => {
    mockResolveResourcesByTopicName.mockResolvedValue([{ resourceType: 'AI_EXPLANATION', status: 'READY', payload: { intro: 'i', body: [], pdfFile: 'hepr101.pdf' } }]);
    const own = [{ card: null, heading: 'Scene I', text: 'play' }];
    mockGetCachedEnrichment.mockResolvedValue({ whatYoullLearn: ['mine'], blocks: [{ type: 'table' }], contentType: 'theory', listenScript: own });
    mockUnitContentForTopic.mockResolvedValue({ section: 'S', pdfPage: 2, lang: 'en', learn: { whatYoullLearn: ['x'], blocks: [{ type: 'overview', text: 'x' }] }, listen: [{ heading: 'other' }], quiz: [] });

    const res = await request(app).get('/teacher/syllabus/topic-by-name/resources').query({ curriculum: 'CBSE', grade: 'Grade 8', subject: 'English', topic: 'Camel' });
    const p = res.body.resources[0].payload;
    expect(p.blocks).toEqual([{ type: 'table' }]);
    expect(p.listenScript).toEqual(own);
    expect('practiceQuiz' in p).toBe(false);
  });

  test('opening a built book section serves its content even when the old topic index does not know it', async () => {
    mockResolveResourcesByTopicName.mockResolvedValue([]);
    mockGetCachedEnrichment.mockResolvedValue(null);
    const learn = { whatYoullLearn: ['किले में जीवन'], blocks: [{ type: 'overview', text: 'x' }] };
    mockSectionByTitle.mockResolvedValue({ pdfFile: 'hhbk101.pdf', pdfPage: 1, section: 'अहमदनगर का किला', lang: 'hi', learn, listen: [{ heading: 'h', text: 't', lines: [] }], quiz: [{ question: 'q', options: ['a', 'b', 'c', 'd'], correctIndex: 0 }] });

    const res = await request(app).get('/teacher/syllabus/topic-by-name/resources').query({ curriculum: 'CBSE', grade: 'Grade 8', subject: 'Hindi', topic: 'अहमदनगर का किला' });
    const ex = res.body.resources.find((r) => r.resourceType === 'AI_EXPLANATION');
    expect(ex.status).toBe('READY');
    expect(ex.payload).toMatchObject({ pdfFile: 'hhbk101.pdf', blocks: learn.blocks, lang: 'hi', pdfPage: 1 });
    expect(ex.payload.practiceQuiz).toHaveLength(1);
    expect(mockGetOrGenerateEnrichment).not.toHaveBeenCalled();
  });

  test('a built Maths section opens with its tutor and Learn built from the same book examples', async () => {
    mockResolveResourcesByTopicName.mockResolvedValue([]);
    mockGetCachedEnrichment.mockResolvedValue(null);
    const tutor = { intro: 'i', keyIdea: 'k', examples: [{ problem: 'p', steps: [{ say: 's', show: '1 + 1 = 2' }], answer: '2' }] };
    mockSectionByTitle.mockResolvedValue({ pdfFile: 'hegp101.pdf', pdfPage: 3, section: '1.1 Square Numbers', lang: 'en', learn: { whatYoullLearn: ['k'], blocks: [{ type: 'overview', text: 'i' }] }, listen: [], quiz: [], mathTutor: tutor });

    const res = await request(app).get('/teacher/syllabus/topic-by-name/resources').query({ curriculum: 'CBSE', grade: 'Grade 8', subject: 'Mathematics', topic: '1.1 Square Numbers' });
    const p = res.body.resources.find((r) => r.resourceType === 'AI_EXPLANATION').payload;
    expect(p.mathTutor).toEqual(tutor);
    expect(p.blocks).toEqual([{ type: 'overview', text: 'i' }]);
    expect(p.pdfPage).toBe(3);
    expect(mockGetOrGenerateEnrichment).not.toHaveBeenCalled();
  });

  test('non-Maths topics never look up a section tutor', async () => {
    mockResolveResourcesByTopicName.mockResolvedValue([{ resourceType: 'AI_EXPLANATION', status: 'READY', payload: { intro: 'i', body: [], pdfFile: 'hepr101.pdf' } }]);
    mockGetOrGenerateEnrichment.mockResolvedValue(null);
    await request(app).get('/teacher/syllabus/topic-by-name/resources').query({ curriculum: 'CBSE', grade: 'Grade 8', subject: 'English', topic: 'Camel' });
    expect(mockMathTutorForTopic).not.toHaveBeenCalled();
  });

  test('no narration script leaves the payload without one (Listen keeps its existing behaviour)', async () => {
    mockGetOrGenerateEnrichment.mockResolvedValue({ whatYoullLearn: ['a'], blocks: [{ type: 'table' }], contentType: 'theory', listenScript: [] });

    const res = await get('unscripted-topic');
    expect('listenScript' in res.body.resources[0].payload).toBe(false);
  });

  test('no pdfPage in the saved lesson leaves the payload without one (viewer falls back to page 1)', async () => {
    mockGetOrGenerateEnrichment.mockResolvedValue({ whatYoullLearn: ['a'], blocks: [{ type: 'table' }], contentType: 'theory' });

    const res = await get('unpaged-topic');
    expect('pdfPage' in res.body.resources[0].payload).toBe(false);
  });

  test('after 3 failures in a row the AI is skipped for other topics, but already-saved rich lessons still show', async () => {
    mockGetOrGenerateEnrichment.mockResolvedValue(null);
    await get('t1'); await get('t2'); await get('t3'); // trips the breaker
    mockGetOrGenerateEnrichment.mockClear();
    mockGetCachedEnrichment.mockImplementation(async ({ topic }) => (topic === 'saved-topic'
      ? { structured_content: { whatYoullLearn: ['w'], blocks: [{ type: 'table' }] }, content_type: 'theory' }
      : null));

    const saved = await get('saved-topic');
    const fresh = await get('brand-new-topic');
    expect(mockGetOrGenerateEnrichment).not.toHaveBeenCalled();
    expect(saved.body.resources[0].payload.blocks).toEqual([{ type: 'table' }]);
    expect(fresh.body.resources[0].payload).toEqual({ intro: 'plain text' });
  });
});
