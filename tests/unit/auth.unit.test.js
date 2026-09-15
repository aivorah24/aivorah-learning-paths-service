jest.mock('../../services/firebaseAdmin', () => ({}));
jest.mock('../../services/supabase', () => {
  const chain = { select: jest.fn(), eq: jest.fn(), maybeSingle: jest.fn() };
  chain.select.mockReturnValue(chain);
  chain.eq.mockReturnValue(chain);
  return { from: jest.fn(() => chain), _chain: chain };
});

const firebaseAdmin = require('../../services/firebaseAdmin');
const supabase = require('../../services/supabase');
const { requireAuth, requireStudentAuth } = require('../../middleware/auth');

function mockRes() {
  const res = {};
  res.status = jest.fn(() => res);
  res.json = jest.fn(() => res);
  return res;
}

describe('requireAuth', () => {
  beforeEach(() => jest.clearAllMocks());

  test('rejects missing Authorization header', async () => {
    const req = { headers: {} };
    const res = mockRes();
    const next = jest.fn();
    await requireAuth(req, res, next);
    expect(res.status).toHaveBeenCalledWith(401);
    expect(next).not.toHaveBeenCalled();
  });

  test('rejects malformed Authorization header', async () => {
    const req = { headers: { authorization: 'Basic abc' } };
    const res = mockRes();
    const next = jest.fn();
    await requireAuth(req, res, next);
    expect(res.status).toHaveBeenCalledWith(401);
    expect(next).not.toHaveBeenCalled();
  });

  test('rejects an invalid token', async () => {
    firebaseAdmin.auth = jest.fn(() => ({
      verifyIdToken: jest.fn().mockRejectedValue(new Error('bad token')),
    }));
    const req = { headers: { authorization: 'Bearer bad' } };
    const res = mockRes();
    const next = jest.fn();
    await requireAuth(req, res, next);
    expect(res.status).toHaveBeenCalledWith(401);
    expect(next).not.toHaveBeenCalled();
  });

  test('rejects a token with no email claim', async () => {
    firebaseAdmin.auth = jest.fn(() => ({
      verifyIdToken: jest.fn().mockResolvedValue({ uid: 'uid123' }),
    }));
    const req = { headers: { authorization: 'Bearer good' } };
    const res = mockRes();
    const next = jest.fn();
    await requireAuth(req, res, next);
    expect(res.status).toHaveBeenCalledWith(401);
    expect(next).not.toHaveBeenCalled();
  });

  test('403s when no teacher account exists for the email', async () => {
    firebaseAdmin.auth = jest.fn(() => ({
      verifyIdToken: jest.fn().mockResolvedValue({ uid: 'uid123', email: 'student@school.com' }),
    }));
    supabase._chain.maybeSingle
      .mockResolvedValueOnce({ data: { id: 'u1', role: 'student' }, error: null })
      .mockResolvedValueOnce({ data: null, error: null });
    const req = { headers: { authorization: 'Bearer good' } };
    const res = mockRes();
    const next = jest.fn();
    await requireAuth(req, res, next);
    expect(res.status).toHaveBeenCalledWith(403);
    expect(next).not.toHaveBeenCalled();
  });

  test('resolves the users.id and attaches req.auth on a valid teacher token', async () => {
    firebaseAdmin.auth = jest.fn(() => ({
      verifyIdToken: jest.fn().mockResolvedValue({ uid: 'uid123', email: 'teacher@school.com' }),
    }));
    supabase._chain.maybeSingle.mockResolvedValueOnce({ data: { id: 'teacher-uuid-1', role: 'teacher' }, error: null });
    const req = { headers: { authorization: 'Bearer good' } };
    const res = mockRes();
    const next = jest.fn();
    await requireAuth(req, res, next);
    expect(req.auth).toEqual({ uid: 'uid123', email: 'teacher@school.com', teacherId: 'teacher-uuid-1' });
    expect(next).toHaveBeenCalled();
  });

  test('returns 500 when Firebase Admin is not configured', async () => {
    jest.resetModules();
    jest.doMock('../../services/firebaseAdmin', () => null);
    const { requireAuth: requireAuthNoAdmin } = require('../../middleware/auth');
    const req = { headers: { authorization: 'Bearer good' } };
    const res = mockRes();
    const next = jest.fn();
    await requireAuthNoAdmin(req, res, next);
    expect(res.status).toHaveBeenCalledWith(500);
    expect(next).not.toHaveBeenCalled();
  });
});

describe('requireStudentAuth', () => {
  beforeEach(() => jest.clearAllMocks());

  test('403s when the resolved account is a teacher, not a student', async () => {
    firebaseAdmin.auth = jest.fn(() => ({
      verifyIdToken: jest.fn().mockResolvedValue({ uid: 'uid123', email: 'teacher@school.com' }),
    }));
    supabase._chain.maybeSingle
      .mockResolvedValueOnce({ data: { id: 'u1', role: 'teacher' }, error: null })
      .mockResolvedValueOnce({ data: null, error: null });
    const req = { headers: { authorization: 'Bearer good' } };
    const res = mockRes();
    const next = jest.fn();
    await requireStudentAuth(req, res, next);
    expect(res.status).toHaveBeenCalledWith(403);
    expect(next).not.toHaveBeenCalled();
  });

  test('resolves the users.id and attaches req.auth.studentId on a valid student token', async () => {
    firebaseAdmin.auth = jest.fn(() => ({
      verifyIdToken: jest.fn().mockResolvedValue({ uid: 'uid456', email: 'student@school.com' }),
    }));
    supabase._chain.maybeSingle.mockResolvedValueOnce({ data: { id: 'student-uuid-1', role: 'student' }, error: null });
    const req = { headers: { authorization: 'Bearer good' } };
    const res = mockRes();
    const next = jest.fn();
    await requireStudentAuth(req, res, next);
    expect(req.auth).toEqual({ uid: 'uid456', email: 'student@school.com', studentId: 'student-uuid-1' });
    expect(next).toHaveBeenCalled();
  });

  test('rejects missing Authorization header the same way as requireAuth', async () => {
    const req = { headers: {} };
    const res = mockRes();
    const next = jest.fn();
    await requireStudentAuth(req, res, next);
    expect(res.status).toHaveBeenCalledWith(401);
    expect(next).not.toHaveBeenCalled();
  });
});
