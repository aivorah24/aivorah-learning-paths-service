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
jest.mock('../../services/curriculum/resourceResolver', () => ({
  resolveAllResources: (...args) => mockResolveAllResources(...args),
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
});

describe('GET /teacher/syllabus/current', () => {
  test('no chapters at all -> empty units list, no crash', async () => {
    supabase._chain.order.mockResolvedValueOnce({ data: [], error: null });

    const res = await request(app).get('/teacher/syllabus/current').query({ grade: 'Grade 4', subject: 'Mathematics' });

    expect(res.status).toBe(200);
    expect(res.body.units).toEqual([]);
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
