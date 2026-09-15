jest.mock('../../services/firebaseAdmin', () => ({}));
jest.mock('../../services/supabase', () => {
  const chain = { select: jest.fn(), eq: jest.fn(), maybeSingle: jest.fn() };
  chain.select.mockReturnValue(chain);
  chain.eq.mockReturnValue(chain);
  return { from: jest.fn(() => chain), _chain: chain };
});

const firebaseAdmin = require('../../services/firebaseAdmin');
const supabase = require('../../services/supabase');
const { requireAuth } = require('../../middleware/auth');

function mockRes() {
  const res = {};
  res.status = jest.fn(() => res);
  res.json = jest.fn(() => res);
  return res;
}

describe('requireAuth regression', () => {
  beforeEach(() => jest.clearAllMocks());

  test('resolves a dual-role teacher who is registered as a parent', async () => {
    firebaseAdmin.auth = jest.fn(() => ({
      verifyIdToken: jest.fn().mockResolvedValue({ uid: 'uid123', email: 'parent_teacher@school.com' }),
    }));
    
    // First query to users returns role: 'parent'
    supabase._chain.maybeSingle.mockResolvedValueOnce({ data: { id: 'parent-uuid-1', role: 'parent' }, error: null });
    // Second query to user_preferences returns roles: ['parent', 'teacher']
    supabase._chain.maybeSingle.mockResolvedValueOnce({ data: { data: { roles: ['parent', 'teacher'] } }, error: null });
    
    const req = { headers: { authorization: 'Bearer good' } };
    const res = mockRes();
    const next = jest.fn();
    
    await requireAuth(req, res, next);
    
    // Should succeed because they have the 'teacher' role in user_preferences
    expect(res.status).not.toHaveBeenCalledWith(403);
    expect(next).toHaveBeenCalled();
    expect(req.auth.teacherId).toBe('parent-uuid-1');
  });

  test('resolves when email casing does not match between Firebase and Supabase', async () => {
    firebaseAdmin.auth = jest.fn(() => ({
      verifyIdToken: jest.fn().mockResolvedValue({ uid: 'uid123', email: 'Teacher@School.com' }),
    }));
    
    // The query should match against lowercase email 'teacher@school.com'
    supabase._chain.eq.mockImplementation((field, value) => {
      if (field === 'email' && value === 'teacher@school.com') {
        supabase._chain.maybeSingle.mockResolvedValueOnce({ data: { id: 'teacher-uuid-1', role: 'teacher' }, error: null });
      } else {
        supabase._chain.maybeSingle.mockResolvedValueOnce({ data: null, error: null });
      }
      return supabase._chain;
    });

    const req = { headers: { authorization: 'Bearer good' } };
    const res = mockRes();
    const next = jest.fn();
    
    await requireAuth(req, res, next);
    
    expect(supabase._chain.eq).toHaveBeenCalledWith('email', 'teacher@school.com');
    expect(res.status).not.toHaveBeenCalledWith(403);
    expect(next).toHaveBeenCalled();
  });
});
