jest.mock('../../services/supabase', () => ({ from: jest.fn() }));

const supabase = require('../../services/supabase');
const repo = require('../../services/readAloud/repository');

function chain(response) {
  const c = {};
  ['select', 'eq', 'order', 'limit', 'upsert', 'insert'].forEach((m) => { c[m] = jest.fn(() => c); });
  c.maybeSingle = jest.fn(() => Promise.resolve(response));
  c.then = (resolve, reject) => Promise.resolve(response).then(resolve, reject);
  return c;
}

beforeEach(() => jest.clearAllMocks());

test('getLevel returns null for a new student and the row otherwise', async () => {
  supabase.from.mockReturnValueOnce(chain({ data: null, error: null }));
  await expect(repo.getLevel('s1')).resolves.toBeNull();
  const c = chain({ data: { lexile: 500, history: null }, error: null });
  supabase.from.mockReturnValueOnce(c);
  await expect(repo.getLevel('s1')).resolves.toEqual({ lexile: 500, history: [] });
  expect(supabase.from).toHaveBeenLastCalledWith('read_aloud_levels');
  expect(c.eq).toHaveBeenCalledWith('student_id', 's1');
});

test('saveLevel upserts by student and keeps only the last 50 changes', async () => {
  const c = chain({ error: null });
  supabase.from.mockReturnValueOnce(c);
  const previous = { lexile: 400, history: Array.from({ length: 50 }, (_, i) => ({ lexile: i })) };
  const saved = await repo.saveLevel('s1', 425, { source: 'auto' }, previous);
  expect(saved.history).toHaveLength(50);
  expect(saved.history[49]).toEqual(expect.objectContaining({ lexile: 425, source: 'auto' }));
  expect(c.upsert).toHaveBeenCalledWith(expect.objectContaining({ student_id: 's1', lexile: 425 }), { onConflict: 'student_id' });
});

test('addSession maps to columns; errors are thrown', async () => {
  const c = chain({ error: null });
  supabase.from.mockReturnValueOnce(c);
  await repo.addSession('s1', { topic: 'T', grade: 'Grade 3', accuracy: 90, wcpm: 60, level: 'good', totalWords: 80, duration: 70, starsEarned: 50, lexile: null });
  expect(supabase.from).toHaveBeenCalledWith('read_aloud_sessions');
  expect(c.insert).toHaveBeenCalledWith(expect.objectContaining({ student_id: 's1', total_words: 80, duration_seconds: 70, stars_earned: 50 }));
  supabase.from.mockReturnValueOnce(chain({ error: { message: 'boom' } }));
  await expect(repo.addSession('s1', {})).rejects.toThrow('boom');
});

test('listSessions returns newest first in API shape', async () => {
  const c = chain({ data: [{ created_at: 'd', topic: 'T', grade: 'G', accuracy: 1, wcpm: 2, level: 'good', total_words: 3, duration_seconds: 4, stars_earned: 5, lexile: 6 }], error: null });
  supabase.from.mockReturnValueOnce(c);
  await expect(repo.listSessions('s1')).resolves.toEqual([{ date: 'd', topic: 'T', grade: 'G', accuracy: 1, wcpm: 2, level: 'good', totalWords: 3, duration: 4, starsEarned: 5, lexile: 6 }]);
  expect(c.order).toHaveBeenCalledWith('created_at', { ascending: false });
});
