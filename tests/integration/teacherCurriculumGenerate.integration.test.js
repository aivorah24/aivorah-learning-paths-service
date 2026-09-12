jest.mock('../../middleware/auth', () => ({
  requireAuth: (req, res, next) => {
    req.auth = { uid: 'uid1', email: 'teacher@school.com', teacherId: 'teacher-uuid-1' };
    next();
  },
}));

const mockUpdateCurriculumStatus = jest.fn();
jest.mock('../../services/curriculumUpload/curriculumRepository', () => ({
  createCurriculum: jest.fn(),
  updateCurriculumStatus: (...args) => mockUpdateCurriculumStatus(...args),
}));

const mockPublishJob = jest.fn();
jest.mock('../../services/jobQueue', () => ({ publishJob: (...args) => mockPublishJob(...args) }));

jest.mock('../../services/curriculumUpload/cloudinaryStorage', () => ({ uploadCurriculumFile: jest.fn() }));
jest.mock('../../services/curriculumUpload/learningPathRepository', () => ({
  getDraftByCurriculumId: jest.fn(),
  updateDraftContent: jest.fn(),
  getLearningPathByCurriculumId: jest.fn(),
  publishLearningPath: jest.fn(),
}));

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

function ownedCurriculum(status) {
  return { data: { id: 'c1', teacher_id: 'teacher-uuid-1', status }, error: null };
}

beforeEach(() => jest.clearAllMocks());

describe('POST /teacher-curriculum/:id/generate', () => {
  test('enqueues a job and marks the curriculum generating', async () => {
    supabase._chain.maybeSingle.mockResolvedValueOnce(ownedCurriculum('processed'));
    mockPublishJob.mockResolvedValueOnce({ jobId: 'job1' });
    mockUpdateCurriculumStatus.mockResolvedValueOnce({ id: 'c1', status: 'generating' });

    const res = await request(app).post('/teacher-curriculum/c1/generate');

    expect(res.status).toBe(202);
    expect(mockPublishJob).toHaveBeenCalledWith('curriculum_generate', { curriculumId: 'c1' });
    expect(res.body.curriculum.status).toBe('generating');
    expect(res.body.jobId).toBe('job1');
  });

  test('403s for a curriculum owned by a different teacher', async () => {
    supabase._chain.maybeSingle.mockResolvedValueOnce({ data: { id: 'c1', teacher_id: 'someone-else' }, error: null });
    const res = await request(app).post('/teacher-curriculum/c1/generate');
    expect(res.status).toBe(403);
    expect(mockPublishJob).not.toHaveBeenCalled();
  });

  test('404s when the curriculum does not exist', async () => {
    supabase._chain.maybeSingle.mockResolvedValueOnce({ data: null, error: null });
    const res = await request(app).post('/teacher-curriculum/missing/generate');
    expect(res.status).toBe(404);
  });

  test('409s when the curriculum is not yet processed', async () => {
    supabase._chain.maybeSingle.mockResolvedValueOnce(ownedCurriculum('processing'));
    const res = await request(app).post('/teacher-curriculum/c1/generate');
    expect(res.status).toBe(409);
    expect(mockPublishJob).not.toHaveBeenCalled();
  });

  test('marks the curriculum failed when the job cannot be enqueued', async () => {
    supabase._chain.maybeSingle.mockResolvedValueOnce(ownedCurriculum('processed'));
    mockPublishJob.mockRejectedValueOnce(new Error('queue down'));
    mockUpdateCurriculumStatus.mockResolvedValueOnce({ id: 'c1', status: 'failed', error: 'Failed to queue generation job' });

    const res = await request(app).post('/teacher-curriculum/c1/generate');

    expect(res.status).toBe(500);
    expect(mockUpdateCurriculumStatus).toHaveBeenCalledWith('c1', 'failed', { error: 'Failed to queue generation job' });
  });
});
