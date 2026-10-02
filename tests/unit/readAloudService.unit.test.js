const mockRepo = { getLevel: jest.fn(), saveLevel: jest.fn(), addSession: jest.fn(), listSessions: jest.fn() };
jest.mock('../../services/readAloud/repository', () => mockRepo);
const mockTranscribe = jest.fn();
jest.mock('../../services/readAloud/whisper', () => ({
  ...jest.requireActual('../../services/readAloud/whisper'),
  transcribe: (...a) => mockTranscribe(...a),
}));
jest.mock('../../services/llm/fallback', () => ({ callWithFallback: jest.fn().mockResolvedValue('Well done!') }));

const service = require('../../services/readAloud/readAloudService');

beforeEach(() => {
  jest.clearAllMocks();
  mockRepo.saveLevel.mockResolvedValue({});
  mockRepo.addSession.mockResolvedValue();
});

describe('lexile', () => {
  test('a student with no level needs calibration', async () => {
    mockRepo.getLevel.mockResolvedValueOnce(null);
    await expect(service.getLexile('s1')).resolves.toEqual({ lexile: null, needsCalibration: true });
  });

  test('returns the stored level', async () => {
    mockRepo.getLevel.mockResolvedValueOnce({ lexile: 450, history: [{ lexile: 450 }] });
    await expect(service.getLexile('s1')).resolves.toEqual({ lexile: 450, level: 'medium', history: [{ lexile: 450 }], needsCalibration: false });
  });

  test('setting a level clamps it and keeps the history', async () => {
    const previous = { lexile: 400, history: [] };
    mockRepo.getLevel.mockResolvedValueOnce(previous);
    await expect(service.setLexile('s1', 1200, 'calibration')).resolves.toEqual({ lexile: 900, level: 'hard' });
    expect(mockRepo.saveLevel).toHaveBeenCalledWith('s1', 900, { source: 'calibration' }, previous);
  });
});

describe('assess', () => {
  const passage = 'one two three four five six seven eight nine ten';
  const allCorrect = new Array(10).fill('correct');

  test('scores, steps a calibrated student up after a clean read, and saves the session', async () => {
    mockRepo.getLevel.mockResolvedValueOnce({ lexile: 400, history: [] });
    const r = await service.assess('s1', { passage, wordStatuses: allCorrect, duration: 30, grade: 'Grade 3', topic: 'Numbers' });
    expect(r).toEqual(expect.objectContaining({ accuracy: 100, wcpm: 20, level: 'excellent', feedback: 'Well done!', starsEarned: 50, lexile: 425, lexileChange: 25 }));
    expect(mockRepo.saveLevel).toHaveBeenCalledWith('s1', 425, { source: 'auto', errors: 0 }, { lexile: 400, history: [] });
    expect(mockRepo.addSession).toHaveBeenCalledWith('s1', expect.objectContaining({ topic: 'Numbers', grade: 'Grade 3', accuracy: 100, lexile: 425 }));
  });

  test('steps down after many errors, reporting the clamped change', async () => {
    mockRepo.getLevel.mockResolvedValueOnce({ lexile: 110, history: [] });
    const r = await service.assess('s1', { passage, wordStatuses: new Array(10).fill('skipped'), duration: 30 });
    expect(r.lexile).toBe(100);
    expect(r.lexileChange).toBe(-10);
  });

  test('an uncalibrated student gets no Lexile and a failed session save is not fatal', async () => {
    mockRepo.getLevel.mockResolvedValueOnce(null);
    mockRepo.addSession.mockRejectedValueOnce(new Error('db down'));
    const r = await service.assess('s1', { passage, wordStatuses: allCorrect, duration: 30 });
    expect(r.lexile).toBeNull();
    expect(r.lexileChange).toBe(0);
    expect(mockRepo.saveLevel).not.toHaveBeenCalled();
  });
});

describe('history', () => {
  test('empty', async () => {
    mockRepo.listSessions.mockResolvedValueOnce([]);
    await expect(service.history('s1')).resolves.toEqual({ history: [], stats: {} });
  });

  test('oldest-first recent sessions with stats', async () => {
    mockRepo.listSessions.mockResolvedValueOnce([
      { date: '2026-10-02', accuracy: 90, wcpm: 60 },
      { date: '2026-10-01', accuracy: 70, wcpm: 40 },
    ]);
    const h = await service.history('s1');
    expect(h.history.map((x) => x.date)).toEqual(['2026-10-01', '2026-10-02']);
    expect(h.stats).toEqual({ avgAccuracy: 80, avgWcpm: 50, totalSessions: 2, bestAccuracy: 90, bestWcpm: 60 });
  });
});

describe('transcription', () => {
  const file = { buffer: Buffer.from('x'), mimetype: 'audio/webm' };

  test('a full recording is matched word by word', async () => {
    mockTranscribe.mockResolvedValueOnce({ text: 'the sun', words: [{ word: 'the' }, { word: 'sun' }] });
    const r = await service.transcribeRecording(file, 'The sun shines');
    expect(r).toEqual({ transcript: 'the sun', whisperWords: ['the', 'sun'], wordStatuses: ['correct', 'correct', 'skipped'], matchedUpTo: 2, totalWords: 3 });
  });

  test('live: ignores hallucinated clips', async () => {
    mockTranscribe.mockResolvedValueOnce({ duration: 4, words: [{ word: 'the', start: 0, end: 0.1 }] });
    await expect(service.transcribeLive(file, 'The sun shines')).resolves.toEqual({ wordStatuses: ['pending', 'pending', 'pending'], matchedUpTo: 0 });
  });

  test('live: caps progress at three words a second', async () => {
    const words = 'a b c d e f'.split(' ').map((w, i) => ({ word: w, start: i * 0.1, end: i * 0.1 + 0.1 }));
    mockTranscribe.mockResolvedValueOnce({ duration: 0.9, words });
    const r = await service.transcribeLive(file, 'a b c d e f g');
    expect(r.matchedUpTo).toBe(3);
    expect(r.wordStatuses.slice(2, 5)).toEqual(['correct', 'current', 'pending']);
  });

  test('live: an empty passage needs no transcription', async () => {
    await expect(service.transcribeLive(file, '')).resolves.toEqual({ wordStatuses: [], matchedUpTo: 0 });
    expect(mockTranscribe).not.toHaveBeenCalled();
  });
});
