jest.mock('../../middleware/auth', () => ({
  requireAuth: (req, res, next) => {
    req.auth = { uid: 'uid1', email: 't@school.com', teacherId: 'teacher-uuid-1' };
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
  const chain = { select: jest.fn(), eq: jest.fn(), maybeSingle: jest.fn(), order: jest.fn(), limit: jest.fn() };
  ['select', 'eq', 'order'].forEach((m) => chain[m].mockReturnValue(chain));
  return { from: jest.fn(() => chain), _chain: chain };
});

const express = require('express');
const request = require('supertest');
const supabase = require('../../services/supabase');
const route = require('../../routes/teacherCurriculum');

const app = express();
app.use(express.json());
app.use('/teacher-curriculum', route);

const owned = (status, extra = {}) => ({ data: { id: 'c1', teacher_id: 'teacher-uuid-1', status, ...extra }, error: null });

beforeEach(() => jest.clearAllMocks());

describe('GET /teacher-curriculum', () => {
  test('lists own curricula newest first, capped at 20, progress on the newest only', async () => {
    supabase._chain.limit.mockResolvedValueOnce({ data: [{ id: 'c2', status: 'generated' }, { id: 'c1', status: 'failed' }], error: null });
    const res = await request(app).get('/teacher-curriculum?limit=99');
    expect(res.status).toBe(200);
    expect(supabase._chain.eq).toHaveBeenCalledWith('teacher_id', 'teacher-uuid-1');
    expect(supabase._chain.order).toHaveBeenCalledWith('created_at', { ascending: false });
    expect(supabase._chain.limit).toHaveBeenCalledWith(20);
    expect(res.body.curricula[0].progress.stage).toBe('done');
    expect(res.body.curricula[1]).not.toHaveProperty('progress');
  });

  test('defaults the limit to 5', async () => {
    supabase._chain.limit.mockResolvedValueOnce({ data: [], error: null });
    await request(app).get('/teacher-curriculum');
    expect(supabase._chain.limit).toHaveBeenCalledWith(5);
  });
});

describe('POST /teacher-curriculum/:id/retry', () => {
  test('failed with extracted structure re-enqueues generation', async () => {
    supabase._chain.maybeSingle.mockResolvedValueOnce(owned('failed', { extracted_structure: { format: 'docx', text: 'Topic 1: X' } }));
    mockPublishJob.mockResolvedValueOnce({ jobId: 'j1' });
    mockUpdateCurriculumStatus.mockResolvedValueOnce({ id: 'c1', status: 'generating' });
    const res = await request(app).post('/teacher-curriculum/c1/retry');
    expect(res.status).toBe(202);
    expect(mockPublishJob).toHaveBeenCalledWith('curriculum_generate', { curriculumId: 'c1' });
    expect(mockUpdateCurriculumStatus).toHaveBeenCalledWith('c1', 'generating', { error: null });
  });

  test('failed with only the upload settings saved re-enqueues extraction', async () => {
    supabase._chain.maybeSingle.mockResolvedValueOnce(owned('failed', { extracted_structure: { uploadConfig: { grade: '6' } } }));
    mockPublishJob.mockResolvedValueOnce({ jobId: 'j1' });
    mockUpdateCurriculumStatus.mockResolvedValueOnce({ id: 'c1', status: 'processing' });
    const res = await request(app).post('/teacher-curriculum/c1/retry');
    expect(res.status).toBe(202);
    expect(mockPublishJob).toHaveBeenCalledWith('curriculum_extract', { curriculumId: 'c1' });
  });

  test('failed without extracted structure re-enqueues extraction', async () => {
    supabase._chain.maybeSingle.mockResolvedValueOnce(owned('failed', { extracted_structure: null }));
    mockPublishJob.mockResolvedValueOnce({ jobId: 'j1' });
    mockUpdateCurriculumStatus.mockResolvedValueOnce({ id: 'c1', status: 'processing' });
    const res = await request(app).post('/teacher-curriculum/c1/retry');
    expect(res.status).toBe(202);
    expect(mockPublishJob).toHaveBeenCalledWith('curriculum_extract', { curriculumId: 'c1' });
    expect(mockUpdateCurriculumStatus).toHaveBeenCalledWith('c1', 'processing', { error: null });
  });

  test('409 unless failed, 403 for another owner, 404 when missing', async () => {
    supabase._chain.maybeSingle.mockResolvedValueOnce(owned('generating'));
    expect((await request(app).post('/teacher-curriculum/c1/retry')).status).toBe(409);
    supabase._chain.maybeSingle.mockResolvedValueOnce({ data: { id: 'c1', teacher_id: 'x', status: 'failed' }, error: null });
    expect((await request(app).post('/teacher-curriculum/c1/retry')).status).toBe(403);
    supabase._chain.maybeSingle.mockResolvedValueOnce({ data: null, error: null });
    expect((await request(app).post('/teacher-curriculum/c1/retry')).status).toBe(404);
    expect(mockPublishJob).not.toHaveBeenCalled();
  });
});
