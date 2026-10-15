// Unit tests for routes/curriculum.js — GET /subjects, GET /syllabus.
// The Qdrant client is mocked; these tests only verify the route's contract
// (grouping/shape, and the "never break the screen" fallback), not Qdrant itself.

const mockListSubjects = jest.fn();
const mockListSyllabus = jest.fn();
const mockTopicCount = jest.fn();
jest.mock('../../services/qdrant', () => ({
  listSubjects: (...args) => mockListSubjects(...args),
  listSyllabus: (...args) => mockListSyllabus(...args),
  topicCount: (...args) => mockTopicCount(...args),
}));

const mockBoardSubjects = jest.fn();
const mockBoardSyllabus = jest.fn();
jest.mock('../../services/boardSyllabus', () => ({
  ...jest.requireActual('../../services/boardSyllabus'),
  listBoardSubjects: (...args) => mockBoardSubjects(...args),
  listBoardSyllabus: (...args) => mockBoardSyllabus(...args),
}));

const express = require('express');
const request = require('supertest');
const curriculumRoute = require('../../routes/curriculum');

const app = express();
app.use(express.json());
app.use('/curriculum', curriculumRoute);

beforeEach(() => {
  jest.clearAllMocks();
});

describe('GET /curriculum/subjects', () => {
  test('missing curriculum or grade -> 400', async () => {
    const res = await request(app).get('/curriculum/subjects').query({ grade: 'Grade 11' });
    expect(res.status).toBe(400);
  });

  test('nothing ingested yet -> empty subjects list, not an error', async () => {
    mockListSubjects.mockResolvedValueOnce([]);

    const res = await request(app).get('/curriculum/subjects').query({ curriculum: 'IB DP', grade: 'Grade 11' });

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ grade: 'Grade 11', curriculum: 'IB DP', subjects: [] });
  });

  test('subjects found -> passed through as-is', async () => {
    mockListSubjects.mockResolvedValueOnce([{ subject: 'Mathematics', topicCount: 2, topics: [] }]);

    const res = await request(app).get('/curriculum/subjects').query({ curriculum: 'IB DP', grade: 'Grade 11' });

    expect(res.body.subjects).toEqual([{ subject: 'Mathematics', topicCount: 2, topics: [] }]);
  });

  test('Qdrant throws -> degrades to empty list instead of a 500', async () => {
    mockListSubjects.mockRejectedValueOnce(new Error('Qdrant unreachable'));

    const res = await request(app).get('/curriculum/subjects').query({ curriculum: 'IB DP', grade: 'Grade 11' });

    expect(res.status).toBe(200);
    expect(res.body.subjects).toEqual([]);
  });
});

describe('GET /curriculum/syllabus', () => {
  test('missing subject -> 400', async () => {
    const res = await request(app).get('/curriculum/syllabus').query({ curriculum: 'IB DP', grade: 'Grade 11' });
    expect(res.status).toBe(400);
  });

  test('no topics ingested -> empty units, not an error', async () => {
    mockListSyllabus.mockResolvedValueOnce([]);

    const res = await request(app)
      .get('/curriculum/syllabus')
      .query({ curriculum: 'IB DP', grade: 'Grade 11', subject: 'Mathematics' });

    expect(res.status).toBe(200);
    expect(res.body.units).toEqual([]);
  });

  test('Qdrant throws -> degrades to empty units instead of a 500', async () => {
    mockListSyllabus.mockRejectedValueOnce(new Error('Qdrant unreachable'));

    const res = await request(app)
      .get('/curriculum/syllabus')
      .query({ curriculum: 'IB DP', grade: 'Grade 11', subject: 'Mathematics' });

    expect(res.status).toBe(200);
    expect(res.body.units).toEqual([]);
  });
});

describe('GET /curriculum/topic-count', () => {
  test('missing curriculum or grade -> 400', async () => {
    const res = await request(app).get('/curriculum/topic-count').query({ grade: 'Grade 3' });
    expect(res.status).toBe(400);
  });

  test('returns totalTopics from the service layer', async () => {
    mockTopicCount.mockResolvedValueOnce(42);

    const res = await request(app).get('/curriculum/topic-count').query({ curriculum: 'IB PYP', grade: 'Grade 3' });

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ totalTopics: 42 });
    expect(mockTopicCount).toHaveBeenCalledWith('IB PYP', 'Grade 3');
  });

  test('service layer already degrades Qdrant errors to 0, not a 500', async () => {
    mockTopicCount.mockResolvedValueOnce(0);

    const res = await request(app).get('/curriculum/topic-count').query({ curriculum: 'CBSE', grade: 'Grade 11' });

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ totalTopics: 0 });
  });
});

describe('ICSE / Cambridge (no textbook yet) route to the board syllabus reader', () => {
  test.each(['ICSE', 'Cambridge'])('%s /subjects uses listBoardSubjects, not the Qdrant-only listSubjects', async (curriculum) => {
    mockBoardSubjects.mockResolvedValueOnce([{ subject: 'English', topicCount: 1, topics: [], units: ['U1'], chapters: [{ unitNo: 1, title: 'U1' }], comingSoon: true }]);
    const res = await request(app).get('/curriculum/subjects').query({ curriculum, grade: 'Grade 6' });
    expect(res.status).toBe(200);
    expect(res.body.subjects[0]).toMatchObject({ subject: 'English', comingSoon: true });
    expect(mockBoardSubjects).toHaveBeenCalledWith(curriculum, 'Grade 6');
    expect(mockListSubjects).not.toHaveBeenCalled();
  });

  test.each(['ICSE', 'Cambridge'])('%s /syllabus uses listBoardSyllabus', async (curriculum) => {
    mockBoardSyllabus.mockResolvedValueOnce([{ unitNo: 1, title: 'U1', topics: [{ id: 't', name: 'T', kind: 'coming_soon', page: '', comingSoon: true }], comingSoon: true, pending: false }]);
    const res = await request(app).get('/curriculum/syllabus').query({ curriculum, grade: 'Grade 3', subject: 'English' });
    expect(res.body.units[0].topics[0].comingSoon).toBe(true);
    expect(mockListSyllabus).not.toHaveBeenCalled();
  });

  test('a board reader failure still degrades to an empty list, not a 500', async () => {
    mockBoardSubjects.mockRejectedValueOnce(new Error('boom'));
    const res = await request(app).get('/curriculum/subjects').query({ curriculum: 'ICSE', grade: 'Grade 6' });
    expect(res.status).toBe(200);
    expect(res.body.subjects).toEqual([]);
  });
});
