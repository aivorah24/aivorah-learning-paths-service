jest.mock('../../middleware/auth', () => ({
  requireStudentAuth: (req, res, next) => {
    if (req.headers.authorization === 'Bearer invalid') {
      return res.status(401).json({ error: 'Invalid or expired token' });
    }
    req.auth = { uid: 'uid1', email: 'student@school.com', studentId: 'student-uuid-1' };
    next();
  },
}));

const mockGetLearningPathByCurriculumId = jest.fn();
const mockListPublishedLearningPathsForTeachers = jest.fn();
jest.mock('../../services/curriculumUpload/learningPathRepository', () => ({
  learningPathTitle: jest.requireActual('../../services/curriculumUpload/learningPathTitle').learningPathTitle,
  getLearningPathByCurriculumId: (...args) => mockGetLearningPathByCurriculumId(...args),
  listPublishedLearningPathsForTeachers: (...args) => mockListPublishedLearningPathsForTeachers(...args),
}));

const mockIsStudentOfTeacher = jest.fn();
const mockListTeacherIdsForStudent = jest.fn();
jest.mock('../../services/curriculumUpload/studentAccess', () => ({
  isStudentOfTeacher: (...args) => mockIsStudentOfTeacher(...args),
  listTeacherIdsForStudent: (...args) => mockListTeacherIdsForStudent(...args),
}));

const mockGetCurriculaByIds = jest.fn();
jest.mock('../../services/curriculumUpload/curriculumRepository', () => ({
  getCurriculaByIds: (...args) => mockGetCurriculaByIds(...args),
}));

const express = require('express');
const request = require('supertest');
const studentLearningPathRoute = require('../../routes/studentLearningPath');

const app = express();
app.use(express.json());
app.use('/student/learning-paths', studentLearningPathRoute);

beforeEach(() => jest.clearAllMocks());

describe('GET /student/learning-paths', () => {
  test('rejects an unauthenticated request', async () => {
    const res = await request(app).get('/student/learning-paths').set('Authorization', 'Bearer invalid');
    expect(res.status).toBe(401);
  });

  test('returns an empty list when the student has no teacher links', async () => {
    mockListTeacherIdsForStudent.mockResolvedValueOnce([]);
    mockListPublishedLearningPathsForTeachers.mockResolvedValueOnce([]);
    mockGetCurriculaByIds.mockResolvedValueOnce([]);

    const res = await request(app).get('/student/learning-paths');

    expect(res.status).toBe(200);
    expect(res.body.learningPaths).toEqual([]);
  });

  test('returns published paths named by the teacher title, else grade + subject, else the file name', async () => {
    mockListTeacherIdsForStudent.mockResolvedValueOnce(['t1']);
    mockListPublishedLearningPathsForTeachers.mockResolvedValueOnce([
      { id: 'lp1', curriculum_id: 'c1', teacher_id: 't1', published_at: '2026-09-12T00:00:00Z', meta: { grade: '6', subject: 'Mathematics' } },
      { id: 'lp2', curriculum_id: 'c2', teacher_id: 't1', published_at: '2026-09-11T00:00:00Z', meta: { title: 'Term 1', grade: '6', subject: 'Science' } },
      { id: 'lp3', curriculum_id: 'c3', teacher_id: 't1', published_at: '2026-09-10T00:00:00Z', meta: null },
    ]);
    mockGetCurriculaByIds.mockResolvedValueOnce([{ id: 'c3', file_name: 'grade6-maths.pdf' }]);

    const res = await request(app).get('/student/learning-paths');

    expect(res.status).toBe(200);
    expect(res.body.learningPaths.map((p) => p.title)).toEqual(['Grade 6 Mathematics', 'Term 1', 'grade6 maths']);
    expect(res.body.learningPaths[0]).toEqual({ id: 'lp1', curriculumId: 'c1', title: 'Grade 6 Mathematics', grade: '6', subject: 'Mathematics', publishedAt: '2026-09-12T00:00:00Z' });
  });

  test('?grade=&subject= keeps only that subject screen\'s paths', async () => {
    mockListTeacherIdsForStudent.mockResolvedValueOnce(['t1']);
    mockListPublishedLearningPathsForTeachers.mockResolvedValueOnce([
      { id: 'lp1', curriculum_id: 'c1', teacher_id: 't1', published_at: 'x', meta: { grade: '6', subject: 'Mathematics' } },
      { id: 'lp2', curriculum_id: 'c2', teacher_id: 't1', published_at: 'x', meta: { grade: '7', subject: 'Mathematics' } },
      { id: 'lp3', curriculum_id: 'c3', teacher_id: 't1', published_at: 'x', meta: { grade: '6', subject: 'Science' } },
    ]);
    mockGetCurriculaByIds.mockResolvedValueOnce([]);

    const res = await request(app).get('/student/learning-paths?grade=Grade%206&subject=mathematics');

    expect(res.body.learningPaths.map((p) => p.id)).toEqual(['lp1']);
  });

  test('500s when the list query fails', async () => {
    mockListTeacherIdsForStudent.mockRejectedValueOnce(new Error('db down'));
    const res = await request(app).get('/student/learning-paths');
    expect(res.status).toBe(500);
  });
});

describe('GET /student/learning-paths/:curriculumId', () => {
  test('rejects an unauthenticated request', async () => {
    const res = await request(app)
      .get('/student/learning-paths/c1')
      .set('Authorization', 'Bearer invalid');

    expect(res.status).toBe(401);
    expect(mockGetLearningPathByCurriculumId).not.toHaveBeenCalled();
  });

  test('returns the published content for a student linked to the teacher', async () => {
    mockGetLearningPathByCurriculumId.mockResolvedValueOnce({
      id: 'lp1', curriculum_id: 'c1', teacher_id: 't1', status: 'published',
      published_at: '2026-09-12T00:00:00Z', published_content: { units: [] }, content: { units: [{ secret: 'draft-only' }] },
    });
    mockIsStudentOfTeacher.mockResolvedValueOnce(true);

    const res = await request(app).get('/student/learning-paths/c1');

    expect(res.status).toBe(200);
    expect(res.body.learningPath).toEqual({
      id: 'lp1', curriculumId: 'c1', publishedAt: '2026-09-12T00:00:00Z', content: { units: [] },
    });
    expect(JSON.stringify(res.body)).not.toContain('draft-only');
  });

  test('404s a draft — never distinguishable from nonexistent', async () => {
    mockGetLearningPathByCurriculumId.mockResolvedValueOnce({ id: 'lp1', teacher_id: 't1', status: 'draft' });
    const res = await request(app).get('/student/learning-paths/c1');
    expect(res.status).toBe(404);
    expect(mockIsStudentOfTeacher).not.toHaveBeenCalled();
  });

  test('404s when nothing exists for this curriculum', async () => {
    mockGetLearningPathByCurriculumId.mockResolvedValueOnce(null);
    const res = await request(app).get('/student/learning-paths/missing');
    expect(res.status).toBe(404);
  });

  test('403s a student not linked to this curriculum\'s teacher', async () => {
    mockGetLearningPathByCurriculumId.mockResolvedValueOnce({
      id: 'lp1', curriculum_id: 'c1', teacher_id: 't-other', status: 'published', published_content: { units: [] },
    });
    mockIsStudentOfTeacher.mockResolvedValueOnce(false);

    const res = await request(app).get('/student/learning-paths/c1');
    expect(res.status).toBe(403);
  });

  test('500s when the learning path fetch fails', async () => {
    mockGetLearningPathByCurriculumId.mockRejectedValueOnce(new Error('db down'));
    const res = await request(app).get('/student/learning-paths/c1');
    expect(res.status).toBe(500);
  });

  test('500s when the authorization check fails', async () => {
    mockGetLearningPathByCurriculumId.mockResolvedValueOnce({
      id: 'lp1', curriculum_id: 'c1', teacher_id: 't1', status: 'published', published_content: { units: [] },
    });
    mockIsStudentOfTeacher.mockRejectedValueOnce(new Error('db down'));

    const res = await request(app).get('/student/learning-paths/c1');
    expect(res.status).toBe(500);
  });
});
