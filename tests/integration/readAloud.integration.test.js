jest.mock('../../middleware/auth', () => ({
  requireStudentAuth: (req, res, next) => {
    if (!req.headers.authorization) return res.status(401).json({ error: 'Missing or malformed Authorization header' });
    if (req.headers.authorization === 'Bearer teacher') return res.status(403).json({ error: 'No student account found for this identity' });
    req.auth = { uid: 'uid1', email: 'student@school.com', studentId: 'student-uuid-1' };
    next();
  },
}));

// Supabase boundary: in-memory tables.
let mockLevels;
let mockSessions;
jest.mock('../../services/supabase', () => {
  const run = (table, op) => {
    if (table === 'read_aloud_levels') {
      if (op.kind === 'select') return { data: mockLevels.get(op.eq.student_id) || null, error: null };
      mockLevels.set(op.row.student_id, { lexile: op.row.lexile, history: op.row.history });
      return { error: null };
    }
    if (op.kind === 'insert') { mockSessions.push({ ...op.row, created_at: new Date().toISOString() }); return { error: null }; }
    return { data: mockSessions.filter((s) => s.student_id === op.eq.student_id).reverse(), error: null };
  };
  return {
    from: (table) => {
      const op = { kind: 'select', eq: {} };
      const q = {
        select: () => q,
        eq: (k, v) => { op.eq[k] = v; return q; },
        order: () => q,
        limit: () => q,
        upsert: (row) => { op.kind = 'upsert'; op.row = row; return q; },
        insert: (row) => { op.kind = 'insert'; op.row = row; return q; },
        maybeSingle: async () => run(table, op),
        then: (res, rej) => Promise.resolve(run(table, op)).then(res, rej),
      };
      return q;
    },
  };
});

jest.mock('../../services/llm/fallback', () => ({ callWithFallback: jest.fn().mockResolvedValue('You read beautifully!') }));
jest.mock('cloudinary', () => ({ v2: { config: jest.fn(), uploader: { upload: jest.fn().mockResolvedValue({ secure_url: 'https://cdn/new.mp3' }) } } }));

const express = require('express');
const request = require('supertest');
const route = require('../../routes/readAloud');
const { pickPassage, calibrationPassage } = require('../../services/readAloud/passages');

const app = express();
app.use(express.json());
app.use('/read-aloud', route);

const AUTH = { Authorization: 'Bearer good' };
const realFetch = global.fetch;

beforeEach(() => {
  mockLevels = new Map();
  mockSessions = [];
  global.fetch = jest.fn();
  process.env.GROQ_API_KEY = 'groq-test';
  process.env.ELEVENLABS_API_KEY = 'el-test';
});
afterAll(() => { global.fetch = realFetch; });

describe('auth', () => {
  test('every route needs a signed-in student', async () => {
    expect((await request(app).get('/read-aloud/passages')).status).toBe(401);
    expect((await request(app).get('/read-aloud/lexile').set('Authorization', 'Bearer teacher')).status).toBe(403);
    expect((await request(app).post('/read-aloud/tts').send({ text: 'x' })).status).toBe(401);
  });
});

describe('passages', () => {
  test('lists the grade\'s passages, recommended level first', async () => {
    const res = await request(app).get('/read-aloud/passages?grade=Grade%203&lexile=250').set(AUTH);
    expect(res.status).toBe(200);
    expect(res.body.grade).toBe('Grade 3');
    expect(res.body.recommendedLevel).toBe('easy');
    expect(res.body.passages[0].level).toBe('easy');
    expect(res.body.passages[0].text).toBeUndefined();
  });

  test('a bad lexile is ignored', async () => {
    const res = await request(app).get('/read-aloud/passages?grade=Grade%204&lexile=abc').set(AUTH);
    expect(res.body.recommendedLevel).toBeNull();
  });

  test('loads the chosen passage and the calibration passage', async () => {
    const p = await request(app).post('/read-aloud/passage').set(AUTH).send({ grade: 'Grade 5', topic: 'The Human Body' });
    expect(p.body).toEqual(expect.objectContaining({ title: 'The Human Body', level: 'easy', source: 'curated' }));
    const c = await request(app).get('/read-aloud/calibration?grade=Grade%205').set(AUTH);
    expect(c.body.title).toBe('The Science of Sound');
  });
});

describe('lexile + assess (data is keyed by the signed-in student, never a sent email)', () => {
  test('calibrate, then a clean read moves the level up and is saved to history', async () => {
    expect((await request(app).get('/read-aloud/lexile?email=someone@else.com').set(AUTH)).body).toEqual({ lexile: null, needsCalibration: true });

    const set = await request(app).post('/read-aloud/lexile').set(AUTH).send({ lexile: 400, source: 'calibration', email: 'someone@else.com' });
    expect(set.body).toEqual({ lexile: 400, level: 'medium' });
    expect([...mockLevels.keys()]).toEqual(['student-uuid-1']);

    const text = pickPassage({ grade: 'Grade 3', topic: 'My Five Senses' }).text;
    const words = text.split(/[-—–\s]+/).filter(Boolean);
    const assess = await request(app).post('/read-aloud/assess').set(AUTH)
      .send({ passage: text, wordStatuses: words.map(() => 'correct'), duration: 60, grade: 'Grade 3', topic: 'Who We Are' });
    expect(assess.status).toBe(200);
    expect(assess.body).toEqual(expect.objectContaining({ accuracy: 100, level: 'excellent', starsEarned: 50, lexile: 425, lexileChange: 25, feedback: 'You read beautifully!' }));

    const lexile = await request(app).get('/read-aloud/lexile').set(AUTH);
    expect(lexile.body.lexile).toBe(425);
    expect(lexile.body.history.map((h) => h.source)).toEqual(['calibration', 'auto']);

    const history = await request(app).get('/read-aloud/history').set(AUTH);
    expect(history.body.stats.totalSessions).toBe(1);
    expect(history.body.history[0]).toEqual(expect.objectContaining({ topic: 'Who We Are', accuracy: 100 }));
  });

  test('rejects bad input', async () => {
    expect((await request(app).post('/read-aloud/lexile').set(AUTH).send({})).status).toBe(400);
    expect((await request(app).post('/read-aloud/assess').set(AUTH).send({ passage: 'a b', wordStatuses: ['correct'], duration: 0 })).status).toBe(400);
    expect((await request(app).post('/read-aloud/assess').set(AUTH).send({ passage: 'a b', wordStatuses: ['great'], duration: 3 })).status).toBe(400);
  });
});

describe('transcribe', () => {
  test('matches the recording against the passage', async () => {
    global.fetch.mockResolvedValueOnce({ ok: true, text: async () => JSON.stringify({ text: 'the sun', words: [{ word: 'The' }, { word: 'sun' }] }) });
    const res = await request(app).post('/read-aloud/transcribe').set(AUTH)
      .attach('audio', Buffer.from('fake-audio'), { filename: 'r.webm', contentType: 'audio/webm' })
      .field('passage', 'The sun shines');
    expect(res.status).toBe(200);
    expect(res.body).toEqual(expect.objectContaining({ wordStatuses: ['correct', 'correct', 'skipped'], matchedUpTo: 2, totalWords: 3 }));
  });

  test('live transcription and errors', async () => {
    global.fetch.mockResolvedValueOnce({ ok: true, text: async () => JSON.stringify({ duration: 2, words: [{ word: 'the', start: 0.2, end: 0.5 }, { word: 'sun', start: 0.6, end: 1.2 }] }) });
    const live = await request(app).post('/read-aloud/transcribe-live').set(AUTH)
      .attach('audio', Buffer.from('a'), { filename: 'l.webm', contentType: 'audio/webm' }).field('passage', 'The sun shines');
    expect(live.body).toEqual({ wordStatuses: ['correct', 'correct', 'current'], matchedUpTo: 2 });

    expect((await request(app).post('/read-aloud/transcribe').set(AUTH).field('passage', 'x')).status).toBe(400);

    global.fetch.mockResolvedValueOnce({ ok: false, status: 500, text: async () => 'down' });
    const failed = await request(app).post('/read-aloud/transcribe').set(AUTH)
      .attach('audio', Buffer.from('a'), { filename: 'r.webm', contentType: 'audio/webm' }).field('passage', 'x');
    expect(failed.status).toBe(500);
    expect(failed.body.error).toMatch(/Whisper 500/);
  });
});

describe('tts', () => {
  test('only narrates shipped passages', async () => {
    const res = await request(app).post('/read-aloud/tts').set(AUTH).send({ text: 'Any text I like' });
    expect(res.status).toBe(400);
    expect(global.fetch).not.toHaveBeenCalled();
  });

  test('returns cached audio for a passage', async () => {
    global.fetch.mockResolvedValueOnce({ ok: true }).mockResolvedValueOnce({ ok: false });
    const res = await request(app).post('/read-aloud/tts').set(AUTH).send({ text: calibrationPassage('Grade 3').text });
    expect(res.status).toBe(200);
    expect(res.body).toEqual(expect.objectContaining({ cached: true, wordTimings: null }));
    expect(res.body.audioUrl).toMatch(/\/video\/upload\/aivorah\/audio\/[0-9a-f]{16}\.mp3$/);
  });

  test('a narration failure is a 503 so the app can use the browser voice', async () => {
    global.fetch.mockResolvedValueOnce({ ok: false }).mockResolvedValueOnce({ ok: false, status: 401, text: async () => 'quota' });
    const res = await request(app).post('/read-aloud/tts').set(AUTH).send({ text: calibrationPassage('Grade 4').text });
    expect(res.status).toBe(503);
    expect(res.body.error).toMatch(/ElevenLabs 401/);
  });
});
