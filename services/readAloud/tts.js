// "Listen first" narration: ElevenLabs speech + per-word timings, cached on Cloudinary.
const crypto = require('crypto');
const cloudinary = require('cloudinary').v2;
const { splitWords } = require('./wordMatching');

cloudinary.config({
  cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
  api_key: process.env.CLOUDINARY_API_KEY,
  api_secret: process.env.CLOUDINARY_API_SECRET,
});

const VOICE_ID = process.env.EL_VOICE_READALOUD || 'XrExE9yKIg1WjnnlVkGX'; // Matilda
const VOICE_SETTINGS = { stability: 0.75, similarity_boost: 0.78, style: 0.45, use_speaker_boost: false };

// Same key and Cloudinary ids as the monolith, so audio it already made is reused.
function cacheKey(text) {
  return crypto.createHash('md5').update(text).digest('hex').slice(0, 16);
}

function audioUrl(key) {
  return `https://res.cloudinary.com/${process.env.CLOUDINARY_CLOUD_NAME}/video/upload/aivorah/audio/${key}.mp3`;
}

function timingsUrl(key) {
  return `https://res.cloudinary.com/${process.env.CLOUDINARY_CLOUD_NAME}/raw/upload/aivorah/audio/${key}_timings`;
}

function alignmentToWordTimings(text, alignment) {
  if (!alignment?.characters?.length || !alignment.character_start_times_seconds?.length) return null;
  const chars = alignment.characters;
  const starts = alignment.character_start_times_seconds;
  const ends = alignment.character_end_times_seconds || [];
  const timings = [];
  let ai = 0;
  for (const word of splitWords(text)) {
    while (ai < chars.length && chars[ai] === ' ') ai++;
    const startAi = ai;
    let letters = 0;
    while (ai < chars.length && letters < word.length) {
      if (chars[ai] !== ' ') letters++;
      ai++;
    }
    const endAi = Math.min(ai - 1, chars.length - 1);
    const startTime = starts[startAi] ?? 0;
    timings.push({ word, startTime, endTime: ends[endAi] ?? startTime + 0.1 });
  }
  return timings;
}

async function generateSpeech(text) {
  const apiKey = process.env.ELEVENLABS_API_KEY || process.env.ELEVENLABS_AIVORAH_KEY;
  if (!apiKey) throw new Error('Narration is not configured');
  const modelId = process.env.ELEVENLABS_MODEL_ID || 'eleven_turbo_v2_5';
  const res = await fetch(`https://api.elevenlabs.io/v1/text-to-speech/${VOICE_ID}/with-timestamps`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'xi-api-key': apiKey },
    body: JSON.stringify({ text, model_id: modelId, voice_settings: VOICE_SETTINGS }),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`ElevenLabs ${res.status}: ${body.slice(0, 200)}`);
  }
  const json = await res.json();
  return { buffer: Buffer.from(json.audio_base64, 'base64'), wordTimings: alignmentToWordTimings(text, json.alignment) };
}

async function findCached(key) {
  const head = await fetch(audioUrl(key), { method: 'HEAD' }).catch(() => null);
  if (!head?.ok) return null;
  let wordTimings = null;
  try {
    const t = await fetch(timingsUrl(key));
    if (t.ok) wordTimings = await t.json();
  } catch { /* narration still plays, highlight falls back to estimated timing */ }
  return { audioUrl: audioUrl(key), wordTimings, cached: true };
}

async function saveToCache(key, buffer, wordTimings) {
  const uploaded = await cloudinary.uploader.upload(`data:audio/mpeg;base64,${buffer.toString('base64')}`, {
    public_id: `aivorah/audio/${key}`, resource_type: 'video', overwrite: false,
  });
  if (wordTimings) {
    await cloudinary.uploader.upload(`data:application/json;base64,${Buffer.from(JSON.stringify(wordTimings)).toString('base64')}`, {
      public_id: `aivorah/audio/${key}_timings`, resource_type: 'raw', overwrite: false,
    });
  }
  return uploaded.secure_url;
}

async function speechFor(text) {
  const key = cacheKey(text);
  const cached = await findCached(key);
  if (cached) return cached;
  const { buffer, wordTimings } = await generateSpeech(text);
  const url = await saveToCache(key, buffer, wordTimings);
  return { audioUrl: url, wordTimings, cached: false };
}

module.exports = { speechFor, alignmentToWordTimings, cacheKey };
