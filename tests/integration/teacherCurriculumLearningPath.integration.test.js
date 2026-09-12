jest.mock('../../middleware/auth', () => ({
  requireAuth: (req, res, next) => {
    req.auth = { uid: 'uid1', email: 'teacher@school.com', teacherId: 'teacher-uuid-1' };
    next();
  },
}));

const mockGetDraftByCurriculumId = jest.fn();
const mockUpdateDraftContent = jest.fn();
jest.mock('../../services/curriculumUpload/learningPathRepository', () => ({
  getDraftByCurriculumId: (...args) => mockGetDraftByCurriculumId(...args),
  updateDraftContent: (...args) => mockUpdateDraftContent(...args),
  createDraftLearningPath: jest.fn(),
}));

jest.mock('../../services/curriculumUpload/curriculumRepository', () => ({
  createCurriculum: jest.fn(),
  updateCurriculumStatus: jest.fn(),
}));
jest.mock('../../services/curriculumUpload/cloudinaryStorage', () => ({ uploadCurriculumFile: jest.fn() }));
jest.mock('../../services/jobQueue', () => ({ publishJob: jest.fn() }));

jest.mock('../../services/supabase', () => {
  const chain = { select: jest.fn(), eq: jest.fn(), maybeSingle: jest.fn() };
  chain.select.mockReturnValue(chain);
  chain.eq.mockReturnValue(chain);
  return { from: jest.fn(() => chain), _chain: chain };
});

const express = require('express');
const request = require('supertest');
const supabase = require('../../services/supabase');
const teacherCurriculumRoute = require('../../routes/teacherCurriculum');

const app = express();
app.use(express.json());
app.use('/teacher-curriculum', teacherCurriculumRoute);

function ownedCurriculum() {
  return { data: { id: 'c1', teacher_id: 'teacher-uuid-1' }, error: null };
}

function validContent() {
  return {
    version: 1,
    units: [{
      title: 'Numbers', order: 0,
      topics: [{
        title: 'Whole Numbers', order: 0,
        objectives: ['Add two numbers'],
        lessons: [{ title: 'Intro', summary: 'x' }],
        subtopics: [{ title: 'Addition', order: 0 }],
      }],
    }],
  };
}

beforeEach(() => jest.clearAllMocks());

describe('GET /teacher-curriculum/:id/learning-path', () => {
  test('returns the draft for the owning teacher', async () => {
    supabase._chain.maybeSingle.mockResolvedValueOnce(ownedCurriculum());
    mockGetDraftByCurriculumId.mockResolvedValueOnce({ id: 'lp1', content: validContent() });

    const res = await request(app).get('/teacher-curriculum/c1/learning-path');

    expect(res.status).toBe(200);
    expect(res.body.learningPath.id).toBe('lp1');
  });

  test('404s when the curriculum has no draft yet', async () => {
    supabase._chain.maybeSingle.mockResolvedValueOnce(ownedCurriculum());
    mockGetDraftByCurriculumId.mockResolvedValueOnce(null);

    const res = await request(app).get('/teacher-curriculum/c1/learning-path');
    expect(res.status).toBe(404);
  });

  test('403s for a curriculum owned by a different teacher', async () => {
    supabase._chain.maybeSingle.mockResolvedValueOnce({ data: { id: 'c1', teacher_id: 'someone-else' }, error: null });
    const res = await request(app).get('/teacher-curriculum/c1/learning-path');
    expect(res.status).toBe(403);
    expect(mockGetDraftByCurriculumId).not.toHaveBeenCalled();
  });

  test('404s when the curriculum itself does not exist', async () => {
    supabase._chain.maybeSingle.mockResolvedValueOnce({ data: null, error: null });
    const res = await request(app).get('/teacher-curriculum/missing/learning-path');
    expect(res.status).toBe(404);
  });

  test('500s when fetching the draft throws', async () => {
    supabase._chain.maybeSingle.mockResolvedValueOnce(ownedCurriculum());
    mockGetDraftByCurriculumId.mockRejectedValueOnce(new Error('db down'));

    const res = await request(app).get('/teacher-curriculum/c1/learning-path');
    expect(res.status).toBe(500);
  });
});

describe('PUT /teacher-curriculum/:id/learning-path', () => {
  test('validates, persists a valid edit and returns the updated row', async () => {
    supabase._chain.maybeSingle.mockResolvedValueOnce(ownedCurriculum());
    mockGetDraftByCurriculumId.mockResolvedValueOnce({ id: 'lp1', status: 'draft' });
    mockUpdateDraftContent.mockResolvedValueOnce({ id: 'lp1', content: validContent() });

    const res = await request(app)
      .put('/teacher-curriculum/c1/learning-path')
      .send({ content: validContent() });

    expect(res.status).toBe(200);
    expect(mockUpdateDraftContent).toHaveBeenCalledWith('lp1', validContent());
    expect(res.body.learningPath.id).toBe('lp1');
  });

  test('403s for a curriculum owned by a different teacher, before touching the draft', async () => {
    supabase._chain.maybeSingle.mockResolvedValueOnce({ data: { id: 'c1', teacher_id: 'someone-else' }, error: null });

    const res = await request(app).put('/teacher-curriculum/c1/learning-path').send({ content: validContent() });

    expect(res.status).toBe(403);
    expect(mockUpdateDraftContent).not.toHaveBeenCalled();
  });

  test('rejects invalid content before touching the database', async () => {
    supabase._chain.maybeSingle.mockResolvedValueOnce(ownedCurriculum());

    const res = await request(app).put('/teacher-curriculum/c1/learning-path').send({ content: { units: [] } });

    expect(res.status).toBe(400);
    expect(mockGetDraftByCurriculumId).not.toHaveBeenCalled();
    expect(mockUpdateDraftContent).not.toHaveBeenCalled();
  });

  test('404s when there is no draft to edit yet', async () => {
    supabase._chain.maybeSingle.mockResolvedValueOnce(ownedCurriculum());
    mockGetDraftByCurriculumId.mockResolvedValueOnce(null);

    const res = await request(app).put('/teacher-curriculum/c1/learning-path').send({ content: validContent() });

    expect(res.status).toBe(404);
    expect(mockUpdateDraftContent).not.toHaveBeenCalled();
  });

  test('500s when persisting the edit fails', async () => {
    supabase._chain.maybeSingle.mockResolvedValueOnce(ownedCurriculum());
    mockGetDraftByCurriculumId.mockResolvedValueOnce({ id: 'lp1', status: 'draft' });
    mockUpdateDraftContent.mockRejectedValueOnce(new Error('db down'));

    const res = await request(app).put('/teacher-curriculum/c1/learning-path').send({ content: validContent() });

    expect(res.status).toBe(500);
  });
});
