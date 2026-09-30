jest.mock('../../middleware/auth', () => ({
  requireAuth: (req, res, next) => {
    req.auth = { uid: 'uid1', email: 'teacher@school.com', teacherId: 'teacher-uuid-1' };
    next();
  },
}));

const mockGet = jest.fn();
const mockSave = jest.fn();
const mockPublish = jest.fn();
const mockList = jest.fn();
jest.mock('../../services/subjectEdits/repository', () => ({
  getSubjectEdits: (...a) => mockGet(...a),
  saveSubjectDraft: (...a) => mockSave(...a),
  publishSubjectEdits: (...a) => mockPublish(...a),
  listSubjectEditsForTeacher: (...a) => mockList(...a),
}));
const mockUploadImage = jest.fn();
const mockUploadBook = jest.fn();
jest.mock('../../services/curriculumUpload/cloudinaryStorage', () => ({ uploadLessonImage: (...a) => mockUploadImage(...a), uploadLessonBook: (...a) => mockUploadBook(...a) }));

const express = require('express');
const request = require('supertest');
const route = require('../../routes/teacherSubjectEdits');

const app = express();
app.use(express.json());
app.use('/teacher-subject-edits', route);

const SCOPE = { curriculum: 'cbse', grade: '6', subject: 'mathematics' };
beforeEach(() => jest.clearAllMocks());

test('a subject with no changes yet returns an empty outline', async () => {
  mockGet.mockResolvedValueOnce(null);
  const res = await request(app).get('/teacher-subject-edits/subject').query({ curriculum: 'CBSE', grade: 'Grade 6', subject: 'Maths' });
  expect(res.status).toBe(200);
  expect(mockGet).toHaveBeenCalledWith('teacher-uuid-1', SCOPE);
  expect(res.body).toEqual(expect.objectContaining({ edits: { chapters: [], topics: {} }, status: 'none' }));
});

test('saving stores a cleaned draft for this teacher only', async () => {
  mockSave.mockImplementationOnce(async (_t, _s, draft) => ({ draft, updated_at: '2026-09-30T10:00:00Z', published_at: null }));
  const res = await request(app).put('/teacher-subject-edits/subject').send({
    curriculum: 'CBSE', grade: '6', subject: 'Mathematics',
    edits: { chapters: [{ key: 'c1', topics: [] }], topics: { 'c1::a': { blocks: [], junk: 1 } } },
  });
  expect(res.status).toBe(200);
  expect(mockSave).toHaveBeenCalledWith('teacher-uuid-1', SCOPE, { chapters: [{ key: 'c1', topics: [] }], topics: { 'c1::a': { blocks: [] } } });
  expect(res.body.status).toBe('draft');
});

test('bad edits are a 400, not a save', async () => {
  const res = await request(app).put('/teacher-subject-edits/subject').send({ curriculum: 'CBSE', grade: '6', subject: 'Maths', edits: [] });
  expect(res.status).toBe(400);
  expect(mockSave).not.toHaveBeenCalled();
});

test('publishing copies the working copy for students; later edits show as unpublished', async () => {
  mockGet.mockResolvedValueOnce({ id: 'row1', draft: { chapters: [], topics: {} } });
  mockPublish.mockResolvedValueOnce({ draft: { chapters: [], topics: {} }, updated_at: '2026-09-30T10:00:00Z', published_at: '2026-09-30T10:00:00Z' });
  const res = await request(app).post('/teacher-subject-edits/subject/publish').send({ curriculum: 'CBSE', grade: '6', subject: 'Maths' });
  expect(res.status).toBe(200);
  expect(mockPublish).toHaveBeenCalledWith('row1', { chapters: [], topics: {} });
  expect(res.body).toEqual(expect.objectContaining({ status: 'published', hasUnpublishedChanges: false }));

  mockList.mockResolvedValueOnce([{ ...SCOPE, updated_at: '2026-09-30T11:00:00Z', published_at: '2026-09-30T10:00:00Z' }]);
  const list = await request(app).get('/teacher-subject-edits');
  expect(list.body.subjects[0]).toEqual(expect.objectContaining({ subject: 'mathematics', status: 'published', hasUnpublishedChanges: true }));
});

test('publishing before any save is a 404', async () => {
  mockGet.mockResolvedValueOnce(null);
  const res = await request(app).post('/teacher-subject-edits/subject/publish').send({ curriculum: 'CBSE', grade: '6', subject: 'Maths' });
  expect(res.status).toBe(404);
});

test('uploads a lesson picture and rejects other files', async () => {
  mockUploadImage.mockResolvedValueOnce({ url: 'https://img/x.png', width: 10, height: 10 });
  const ok = await request(app).post('/teacher-subject-edits/images').attach('image', Buffer.from('png'), { filename: 'a.png', contentType: 'image/png' });
  expect(ok.status).toBe(200);
  expect(ok.body.url).toBe('https://img/x.png');

  const bad = await request(app).post('/teacher-subject-edits/images').attach('image', Buffer.from('%PDF'), { filename: 'a.pdf', contentType: 'application/pdf' });
  expect(bad.status).toBe(400);
});

test('uploads a teacher book PDF; anything that is not a PDF is refused', async () => {
  mockUploadBook.mockResolvedValueOnce({ url: 'https://res/book_1.pdf', fileName: 'ch1.pdf' });
  const ok = await request(app).post('/teacher-subject-edits/books').attach('book', Buffer.from('%PDF-1.4 x'), { filename: 'ch1.pdf', contentType: 'application/pdf' });
  expect(ok.status).toBe(200);
  expect(ok.body).toEqual({ url: 'https://res/book_1.pdf', fileName: 'ch1.pdf' });

  const bad = await request(app).post('/teacher-subject-edits/books').attach('book', Buffer.from('hello'), { filename: 'x.pdf', contentType: 'application/pdf' });
  expect(bad.status).toBe(400);
  expect(mockUploadBook).toHaveBeenCalledTimes(1);
});
