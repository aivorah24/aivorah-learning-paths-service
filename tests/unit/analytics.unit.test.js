// Unit tests for services/analytics.js — normalizeEmail (pure helper) and
// logEvent (the real Supabase-insert path, with Supabase mocked).

jest.mock('../../services/supabase', () => {
  const chain = { insert: jest.fn() };
  return { from: jest.fn(() => chain), _chain: chain };
});

const supabase = require('../../services/supabase');
const { normalizeEmail, logEvent } = require('../../services/analytics');

beforeEach(() => {
  jest.clearAllMocks();
});

describe('normalizeEmail', () => {
  test('lowercases and trims', () => {
    expect(normalizeEmail('  A@Example.COM  ')).toBe('a@example.com');
  });

  test('null/undefined -> empty string, no crash', () => {
    expect(normalizeEmail(null)).toBe('');
    expect(normalizeEmail(undefined)).toBe('');
  });
});

describe('logEvent', () => {
  test('inserts a snake_case record into analytics_events and returns the camelCase shape', async () => {
    supabase._chain.insert.mockResolvedValueOnce({ error: null });

    const result = await logEvent('ibpyp_quiz_generated', {
      userEmail: 'A@A.com', role: 'student', source: 'ibpyp_quiz', status: 'success',
      latencyMs: 250, topic: 'Fractions', subject: 'Mathematics', grade: 'Grade 4',
    });

    expect(supabase.from).toHaveBeenCalledWith('analytics_events');
    expect(supabase._chain.insert).toHaveBeenCalledWith(
      expect.objectContaining({
        event_type: 'ibpyp_quiz_generated',
        user_email: 'a@a.com', // normalized before insert
        role: 'student', status: 'success', latency_ms: 250,
        topic: 'Fractions', subject: 'Mathematics', grade: 'Grade 4',
      })
    );
    expect(result).toMatchObject({ eventType: 'ibpyp_quiz_generated', userEmail: 'a@a.com', latencyMs: 250 });
  });

  test('missing optional fields default to empty string / null, never undefined in the insert', async () => {
    supabase._chain.insert.mockResolvedValueOnce({ error: null });
    await logEvent('page_view', {});
    const inserted = supabase._chain.insert.mock.calls[0][0];
    expect(inserted.role).toBe('');
    expect(inserted.latency_ms).toBeNull();
    expect(inserted.score).toBeNull();
    expect(inserted.meta).toEqual({});
  });

  test('a Supabase insert error is swallowed — returns null, never throws', async () => {
    supabase._chain.insert.mockResolvedValueOnce({ error: { message: 'insert failed' } });
    const result = await logEvent('page_view', { userEmail: 'a@a.com' });
    expect(result).toBeNull();
  });

  test('a thrown Supabase call is also swallowed — returns null', async () => {
    supabase._chain.insert.mockRejectedValueOnce(new Error('connection reset'));
    const result = await logEvent('page_view', { userEmail: 'a@a.com' });
    expect(result).toBeNull();
  });
});
