jest.mock('cloudinary', () => ({ v2: { config: jest.fn(), uploader: { upload: jest.fn() } } }));

const cloudinary = require('cloudinary').v2;
const { transcribe, vocabularyHint, looksHallucinated, extensionFor } = require('../../services/readAloud/whisper');
const { speechFor, alignmentToWordTimings, cacheKey } = require('../../services/readAloud/tts');

const realFetch = global.fetch;
const env = { ...process.env };
beforeEach(() => {
  jest.clearAllMocks();
  global.fetch = jest.fn();
  process.env.GROQ_API_KEY = 'groq-test';
  process.env.ELEVENLABS_API_KEY = 'el-test';
  process.env.CLOUDINARY_CLOUD_NAME = 'demo';
});
afterAll(() => {
  global.fetch = realFetch;
  process.env = env;
});

describe('whisper', () => {
  test('sends the audio to Groq with a vocabulary hint and returns the JSON', async () => {
    global.fetch.mockResolvedValueOnce({ ok: true, text: async () => JSON.stringify({ text: 'hello', words: [] }) });
    await expect(transcribe(Buffer.from('a'), 'audio/ogg', 'The butterflies visited marigolds')).resolves.toEqual({ text: 'hello', words: [] });
    const [url, init] = global.fetch.mock.calls[0];
    expect(url).toMatch(/api\.groq\.com/);
    expect(init.headers.Authorization).toBe('Bearer groq-test');
    expect(init.body.get('model')).toBe('whisper-large-v3-turbo');
    expect(init.body.get('prompt')).toBe('butterflies, visited, marigolds');
    expect(init.body.get('file').name).toBe('recording.ogg');
  });

  test('throws on an API error or when not configured', async () => {
    global.fetch.mockResolvedValueOnce({ ok: false, status: 429, text: async () => 'rate limited' });
    await expect(transcribe(Buffer.from('a'), 'audio/webm', '')).rejects.toThrow('Whisper 429: rate limited');
    delete process.env.GROQ_API_KEY;
    await expect(transcribe(Buffer.from('a'), 'audio/webm', '')).rejects.toThrow('not configured');
  });

  test('helpers', () => {
    expect(vocabularyHint('a cat and dog')).toBe('');
    expect([extensionFor('audio/mp4'), extensionFor('audio/wav'), extensionFor(undefined)]).toEqual(['mp4', 'wav', 'webm']);
    expect(looksHallucinated([{ start: 0, end: 0.2 }], 6)).toBe(true);
    expect(looksHallucinated([{ start: 0.5, end: 5 }], 6)).toBe(false);
    expect(looksHallucinated([], 0.5)).toBe(false);
  });
});

describe('tts', () => {
  const text = 'Hi there friend.';
  const alignment = {
    characters: [...'Hi there friend.'],
    character_start_times_seconds: [...'Hi there friend.'].map((_, i) => i * 0.1),
    character_end_times_seconds: [...'Hi there friend.'].map((_, i) => i * 0.1 + 0.1),
  };

  test('maps character timings to word timings', () => {
    const t = alignmentToWordTimings(text, alignment);
    expect(t.map((w) => w.word)).toEqual(['Hi', 'there', 'friend.']);
    expect(t[1].startTime).toBeCloseTo(0.3);
    expect(t[2].endTime).toBeCloseTo(1.6);
    expect(alignmentToWordTimings(text, null)).toBeNull();
  });

  test('serves cached audio from Cloudinary without calling ElevenLabs', async () => {
    global.fetch
      .mockResolvedValueOnce({ ok: true })
      .mockResolvedValueOnce({ ok: true, json: async () => [{ word: 'Hi', startTime: 0, endTime: 0.2 }] });
    const res = await speechFor(text);
    expect(res).toEqual({ audioUrl: `https://res.cloudinary.com/demo/video/upload/aivorah/audio/${cacheKey(text)}.mp3`, wordTimings: [{ word: 'Hi', startTime: 0, endTime: 0.2 }], cached: true });
    expect(global.fetch).toHaveBeenCalledTimes(2);
    expect(cloudinary.uploader.upload).not.toHaveBeenCalled();
  });

  test('generates, uploads and returns new audio when not cached', async () => {
    global.fetch
      .mockResolvedValueOnce({ ok: false })
      .mockResolvedValueOnce({ ok: true, json: async () => ({ audio_base64: Buffer.from('mp3').toString('base64'), alignment }) });
    cloudinary.uploader.upload.mockResolvedValueOnce({ secure_url: 'https://cdn/x.mp3' }).mockResolvedValueOnce({});
    const res = await speechFor(text);
    expect(res.audioUrl).toBe('https://cdn/x.mp3');
    expect(res.cached).toBe(false);
    expect(res.wordTimings).toHaveLength(3);
    expect(global.fetch.mock.calls[1][1].headers['xi-api-key']).toBe('el-test');
    expect(cloudinary.uploader.upload.mock.calls[0][1]).toEqual(expect.objectContaining({ public_id: `aivorah/audio/${cacheKey(text)}`, resource_type: 'video' }));
    expect(cloudinary.uploader.upload.mock.calls[1][1]).toEqual(expect.objectContaining({ public_id: `aivorah/audio/${cacheKey(text)}_timings`, resource_type: 'raw' }));
  });

  test('fails clearly when ElevenLabs is not configured or errors', async () => {
    global.fetch.mockResolvedValueOnce({ ok: false });
    delete process.env.ELEVENLABS_API_KEY;
    await expect(speechFor(text)).rejects.toThrow('not configured');
    process.env.ELEVENLABS_API_KEY = 'el-test';
    global.fetch.mockResolvedValueOnce({ ok: false }).mockResolvedValueOnce({ ok: false, status: 401, text: async () => 'bad key' });
    await expect(speechFor(text)).rejects.toThrow('ElevenLabs 401: bad key');
  });
});
