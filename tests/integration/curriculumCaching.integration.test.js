// Speed: subject/syllabus lists may be reused by browsers/CDNs for 5 minutes,
// but a temporary empty fallback (Qdrant error) must never be cached. The
// service also gzips responses (compression middleware in index.js).

const mockListSubjects = jest.fn();
const mockListSyllabus = jest.fn();
jest.mock('../../services/qdrant', () => ({
  listSubjects: (...args) => mockListSubjects(...args),
  listSyllabus: (...args) => mockListSyllabus(...args),
  topicCount: jest.fn(),
}));

const express = require('express');
const compression = require('compression');
const request = require('supertest');
const { normalizeCurriculumParams } = require('../../services/curriculumName');

const app = express();
app.use(compression());
app.use(express.json());
app.use(normalizeCurriculumParams);
app.use('/curriculum', require('../../routes/curriculum'));

const FIVE_MIN = 'public, max-age=300, s-maxage=300';

beforeEach(() => jest.clearAllMocks());

describe('curriculum responses are cacheable for 5 minutes', () => {
  test('CBSE subjects (book data) carry the 5-minute cache header and are gzipped', async () => {
    const res = await request(app)
      .get('/curriculum/subjects')
      .query({ curriculum: 'CBSE', grade: 'Grade 8' })
      .set('Accept-Encoding', 'gzip');
    expect(res.status).toBe(200);
    expect(res.headers['cache-control']).toBe(FIVE_MIN);
    expect(res.headers['content-encoding']).toBe('gzip');
    expect(res.body.subjects.length).toBeGreaterThan(0);
  });

  test('Qdrant-backed subjects carry the cache header', async () => {
    mockListSubjects.mockResolvedValue([{ subject: 'Mathematics', topics: [] }]);
    const res = await request(app).get('/curriculum/subjects').query({ curriculum: 'IB DP', grade: 'Grade 11' });
    expect(res.headers['cache-control']).toBe(FIVE_MIN);
  });

  test('syllabus units carry the cache header', async () => {
    mockListSyllabus.mockResolvedValue([{ title: 'Unit 1', topics: [] }]);
    const res = await request(app).get('/curriculum/syllabus').query({ curriculum: 'IB DP', grade: 'Grade 11', subject: 'Physics' });
    expect(res.headers['cache-control']).toBe(FIVE_MIN);
    expect(res.body.units).toHaveLength(1);
  });

  test('the empty fallback after a Qdrant error is NOT cached', async () => {
    mockListSubjects.mockRejectedValue(new Error('qdrant down'));
    mockListSyllabus.mockRejectedValue(new Error('qdrant down'));
    const subjects = await request(app).get('/curriculum/subjects').query({ curriculum: 'IB DP', grade: 'Grade 11' });
    const syllabus = await request(app).get('/curriculum/syllabus').query({ curriculum: 'IB DP', grade: 'Grade 11', subject: 'Physics' });
    expect(subjects.body.subjects).toEqual([]);
    expect(subjects.headers['cache-control']).toBeUndefined();
    expect(syllabus.body.units).toEqual([]);
    expect(syllabus.headers['cache-control']).toBeUndefined();
  });

  test('a 400 for missing params is not cached', async () => {
    const res = await request(app).get('/curriculum/subjects').query({ curriculum: 'CBSE' });
    expect(res.status).toBe(400);
    expect(res.headers['cache-control']).toBeUndefined();
  });
});
