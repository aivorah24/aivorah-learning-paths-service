jest.mock('../../middleware/auth', () => ({
  requireAuth: (req, res, next) => {
    req.auth = { uid: 'uid1', email: 'teacher@school.com', teacherId: 'teacher-uuid-1' };
    next();
  },
}));

const mockUploadCurriculumFile = jest.fn();
jest.mock('../../services/curriculumUpload/cloudinaryStorage', () => ({
  uploadCurriculumFile: (...args) => mockUploadCurriculumFile(...args),
}));

const mockCreateCurriculum = jest.fn();
const mockUpdateCurriculumStatus = jest.fn();
jest.mock('../../services/curriculumUpload/curriculumRepository', () => ({
  createCurriculum: (...args) => mockCreateCurriculum(...args),
  updateCurriculumStatus: (...args) => mockUpdateCurriculumStatus(...args),
}));

const mockPublishJob = jest.fn();
jest.mock('../../services/jobQueue', () => ({
  publishJob: (...args) => mockPublishJob(...args),
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

function pdfBuffer() { return Buffer.concat([Buffer.from('%PDF-1.4\n'), Buffer.alloc(100)]); }

beforeEach(() => jest.clearAllMocks());

describe('POST /teacher-curriculum/upload', () => {
  test('uploads, persists, queues a job and returns 201', async () => {
    mockUploadCurriculumFile.mockResolvedValueOnce({ url: 'https://cdn/x.pdf', publicId: 'pub1' });
    mockCreateCurriculum.mockResolvedValueOnce({ id: 'c1', status: 'uploaded' });
    mockPublishJob.mockResolvedValueOnce({ jobId: 'job1' });
    mockUpdateCurriculumStatus.mockResolvedValueOnce({ id: 'c1', status: 'processing' });

    const res = await request(app)
      .post('/teacher-curriculum/upload')
      .attach('file', pdfBuffer(), { filename: 'syllabus.pdf', contentType: 'application/pdf' });

    expect(res.status).toBe(201);
    expect(res.body.jobId).toBe('job1');
    expect(res.body.curriculum).toEqual({ id: 'c1', status: 'processing' });
    expect(mockUploadCurriculumFile).toHaveBeenCalled();
    expect(mockCreateCurriculum).toHaveBeenCalledWith(expect.objectContaining({ teacherId: 'teacher-uuid-1' }));
    expect(mockPublishJob).toHaveBeenCalledWith('curriculum_extract', { curriculumId: 'c1' });
  });

  test('rejects a request with no file', async () => {
    const res = await request(app).post('/teacher-curriculum/upload');
    expect(res.status).toBe(400);
    expect(mockUploadCurriculumFile).not.toHaveBeenCalled();
  });

  test('rejects an unsupported file type before touching storage', async () => {
    const res = await request(app)
      .post('/teacher-curriculum/upload')
      .attach('file', Buffer.from('hello'), { filename: 'a.png', contentType: 'image/png' });

    expect(res.status).toBe(400);
    expect(mockUploadCurriculumFile).not.toHaveBeenCalled();
  });

  test('rejects a spoofed mimetype whose content does not match', async () => {
    const res = await request(app)
      .post('/teacher-curriculum/upload')
      .attach('file', Buffer.from('not a real pdf'), { filename: 'a.pdf', contentType: 'application/pdf' });

    expect(res.status).toBe(400);
    expect(mockUploadCurriculumFile).not.toHaveBeenCalled();
  });

  test('returns 502 and creates no DB row when Cloudinary upload fails', async () => {
    mockUploadCurriculumFile.mockRejectedValueOnce(new Error('cloudinary down'));

    const res = await request(app)
      .post('/teacher-curriculum/upload')
      .attach('file', pdfBuffer(), { filename: 'syllabus.pdf', contentType: 'application/pdf' });

    expect(res.status).toBe(502);
    expect(mockCreateCurriculum).not.toHaveBeenCalled();
  });

  test('marks the curriculum failed when job creation fails after a successful upload', async () => {
    mockUploadCurriculumFile.mockResolvedValueOnce({ url: 'https://cdn/x.pdf', publicId: 'pub1' });
    mockCreateCurriculum.mockResolvedValueOnce({ id: 'c1', status: 'uploaded' });
    mockPublishJob.mockRejectedValueOnce(new Error('queue down'));
    mockUpdateCurriculumStatus.mockResolvedValueOnce({ id: 'c1', status: 'failed', error: 'Failed to queue processing job' });

    const res = await request(app)
      .post('/teacher-curriculum/upload')
      .attach('file', pdfBuffer(), { filename: 'syllabus.pdf', contentType: 'application/pdf' });

    expect(res.status).toBe(500);
    expect(mockUpdateCurriculumStatus).toHaveBeenCalledWith('c1', 'failed', { error: 'Failed to queue processing job' });
    expect(res.body.curriculum.status).toBe('failed');
  });
});

describe('GET /teacher-curriculum/:id', () => {
  test('returns the curriculum for its owning teacher', async () => {
    supabase._chain.maybeSingle.mockResolvedValueOnce({
      data: { id: 'c1', teacher_id: 'teacher-uuid-1', status: 'processing' }, error: null,
    });

    const res = await request(app).get('/teacher-curriculum/c1');

    expect(res.status).toBe(200);
    expect(res.body.curriculum.status).toBe('processing');
  });

  test('403s for a curriculum owned by a different teacher', async () => {
    supabase._chain.maybeSingle.mockResolvedValueOnce({
      data: { id: 'c1', teacher_id: 'someone-else' }, error: null,
    });

    const res = await request(app).get('/teacher-curriculum/c1');

    expect(res.status).toBe(403);
  });

  test('404s for a non-existent curriculum', async () => {
    supabase._chain.maybeSingle.mockResolvedValueOnce({ data: null, error: null });
    const res = await request(app).get('/teacher-curriculum/missing');
    expect(res.status).toBe(404);
  });
});
