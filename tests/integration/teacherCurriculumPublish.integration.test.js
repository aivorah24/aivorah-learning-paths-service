jest.mock('../../middleware/auth', () => ({
  requireAuth: (req, res, next) => {
    if (req.headers.authorization === 'Bearer invalid') {
      return res.status(401).json({ error: 'Invalid or expired token' });
    }
    req.auth = { uid: 'uid1', email: 'teacher@school.com', teacherId: 'teacher-uuid-1' };
    next();
  },
}));

const mockGetLearningPathByCurriculumId = jest.fn();
const mockPublishLearningPath = jest.fn();
jest.mock('../../services/curriculumUpload/learningPathRepository', () => ({
  getLearningPathByCurriculumId: (...args) => mockGetLearningPathByCurriculumId(...args),
  publishLearningPath: (...args) => mockPublishLearningPath(...args),
  getDraftByCurriculumId: jest.fn(),
  updateDraftContent: jest.fn(),
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

describe('POST /teacher-curriculum/:id/learning-path/publish', () => {
  test('rejects an unauthenticated request', async () => {
    const res = await request(app)
      .post('/teacher-curriculum/c1/learning-path/publish')
      .set('Authorization', 'Bearer invalid');

    expect(res.status).toBe(401);
    expect(mockGetLearningPathByCurriculumId).not.toHaveBeenCalled();
  });

  test('403s for a curriculum owned by a different teacher', async () => {
    supabase._chain.maybeSingle.mockResolvedValueOnce({ data: { id: 'c1', teacher_id: 'someone-else' }, error: null });

    const res = await request(app).post('/teacher-curriculum/c1/learning-path/publish');

    expect(res.status).toBe(403);
    expect(mockGetLearningPathByCurriculumId).not.toHaveBeenCalled();
  });

  test('404s when the curriculum itself does not exist', async () => {
    supabase._chain.maybeSingle.mockResolvedValueOnce({ data: null, error: null });
    const res = await request(app).post('/teacher-curriculum/missing/learning-path/publish');
    expect(res.status).toBe(404);
  });

  test('404s when there is no learning path at all for this curriculum', async () => {
    supabase._chain.maybeSingle.mockResolvedValueOnce(ownedCurriculum());
    mockGetLearningPathByCurriculumId.mockResolvedValueOnce(null);

    const res = await request(app).post('/teacher-curriculum/c1/learning-path/publish');

    expect(res.status).toBe(404);
    expect(mockPublishLearningPath).not.toHaveBeenCalled();
  });

  test('publishes a valid draft and returns the published row', async () => {
    supabase._chain.maybeSingle.mockResolvedValueOnce(ownedCurriculum());
    mockGetLearningPathByCurriculumId.mockResolvedValueOnce({ id: 'lp1', status: 'draft', content: validContent() });
    mockPublishLearningPath.mockResolvedValueOnce({ id: 'lp1', status: 'published', published_content: validContent() });

    const res = await request(app).post('/teacher-curriculum/c1/learning-path/publish');

    expect(res.status).toBe(200);
    expect(mockPublishLearningPath).toHaveBeenCalledWith('lp1', validContent());
    expect(res.body.learningPath.status).toBe('published');
  });

  test('rejects publishing a draft that fails validation', async () => {
    supabase._chain.maybeSingle.mockResolvedValueOnce(ownedCurriculum());
    mockGetLearningPathByCurriculumId.mockResolvedValueOnce({ id: 'lp1', status: 'draft', content: { units: [] } });

    const res = await request(app).post('/teacher-curriculum/c1/learning-path/publish');

    expect(res.status).toBe(400);
    expect(mockPublishLearningPath).not.toHaveBeenCalled();
  });

  test('Publish updates: an already-published path publishes its edited working copy again', async () => {
    supabase._chain.maybeSingle.mockResolvedValueOnce(ownedCurriculum());
    const edited = validContent();
    mockGetLearningPathByCurriculumId.mockResolvedValueOnce({ id: 'lp1', status: 'published', content: edited, published_content: validContent() });
    mockPublishLearningPath.mockResolvedValueOnce({ id: 'lp1', status: 'published', published_content: edited });

    const res = await request(app).post('/teacher-curriculum/c1/learning-path/publish');

    expect(res.status).toBe(200);
    expect(mockPublishLearningPath).toHaveBeenCalledWith('lp1', edited);
  });

  test('404s when the row disappeared before the publish update', async () => {
    supabase._chain.maybeSingle.mockResolvedValueOnce(ownedCurriculum());
    mockGetLearningPathByCurriculumId.mockResolvedValueOnce({ id: 'lp1', status: 'draft', content: validContent() });
    mockPublishLearningPath.mockResolvedValueOnce(null);

    const res = await request(app).post('/teacher-curriculum/c1/learning-path/publish');

    expect(res.status).toBe(404);
  });

  test('500s when the publish update itself fails', async () => {
    supabase._chain.maybeSingle.mockResolvedValueOnce(ownedCurriculum());
    mockGetLearningPathByCurriculumId.mockResolvedValueOnce({ id: 'lp1', status: 'draft', content: validContent() });
    mockPublishLearningPath.mockRejectedValueOnce(new Error('db down'));

    const res = await request(app).post('/teacher-curriculum/c1/learning-path/publish');

    expect(res.status).toBe(500);
  });

  test('500s when fetching the learning path fails', async () => {
    supabase._chain.maybeSingle.mockResolvedValueOnce(ownedCurriculum());
    mockGetLearningPathByCurriculumId.mockRejectedValueOnce(new Error('db down'));

    const res = await request(app).post('/teacher-curriculum/c1/learning-path/publish');

    expect(res.status).toBe(500);
  });
});
