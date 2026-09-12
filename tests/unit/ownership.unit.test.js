jest.mock('../../services/supabase', () => {
  const chain = { select: jest.fn(), eq: jest.fn(), maybeSingle: jest.fn() };
  chain.select.mockReturnValue(chain);
  chain.eq.mockReturnValue(chain);
  return { from: jest.fn(() => chain), _chain: chain };
});

const supabase = require('../../services/supabase');
const { requireOwnedCurriculum } = require('../../middleware/ownership');

function mockRes() {
  const res = {};
  res.status = jest.fn(() => res);
  res.json = jest.fn(() => res);
  return res;
}

describe('requireOwnedCurriculum', () => {
  beforeEach(() => jest.clearAllMocks());

  test('404s when the curriculum does not exist', async () => {
    supabase._chain.maybeSingle.mockResolvedValueOnce({ data: null, error: null });
    const req = { params: { id: 'c1' }, auth: { teacherId: 'teacher1' } };
    const res = mockRes();
    const next = jest.fn();
    await requireOwnedCurriculum()(req, res, next);
    expect(res.status).toHaveBeenCalledWith(404);
    expect(next).not.toHaveBeenCalled();
  });

  test('403s when a different teacher owns the curriculum', async () => {
    supabase._chain.maybeSingle.mockResolvedValueOnce({ data: { id: 'c1', teacher_id: 'other-teacher' }, error: null });
    const req = { params: { id: 'c1' }, auth: { teacherId: 'teacher1' } };
    const res = mockRes();
    const next = jest.fn();
    await requireOwnedCurriculum()(req, res, next);
    expect(res.status).toHaveBeenCalledWith(403);
    expect(next).not.toHaveBeenCalled();
  });

  test('attaches req.curriculum and calls next for the owning teacher', async () => {
    supabase._chain.maybeSingle.mockResolvedValueOnce({ data: { id: 'c1', teacher_id: 'teacher1' }, error: null });
    const req = { params: { id: 'c1' }, auth: { teacherId: 'teacher1' } };
    const res = mockRes();
    const next = jest.fn();
    await requireOwnedCurriculum()(req, res, next);
    expect(req.curriculum).toEqual({ id: 'c1', teacher_id: 'teacher1' });
    expect(next).toHaveBeenCalled();
  });

  test('surfaces a DB error as 500', async () => {
    supabase._chain.maybeSingle.mockResolvedValueOnce({ data: null, error: { message: 'boom' } });
    const req = { params: { id: 'c1' }, auth: { teacherId: 'teacher1' } };
    const res = mockRes();
    const next = jest.fn();
    await requireOwnedCurriculum()(req, res, next);
    expect(res.status).toHaveBeenCalledWith(500);
    expect(next).not.toHaveBeenCalled();
  });
});
