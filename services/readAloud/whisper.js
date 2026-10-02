// Speech-to-text for a child's recording (Groq Whisper).
const GROQ_TRANSCRIBE_URL = 'https://api.groq.com/openai/v1/audio/transcriptions';
const WHISPER_MODEL = 'whisper-large-v3-turbo';

function extensionFor(mimeType = '') {
  if (mimeType.includes('ogg')) return 'ogg';
  if (mimeType.includes('mp4')) return 'mp4';
  if (mimeType.includes('wav')) return 'wav';
  return 'webm';
}

// Whisper treats a prompt as "already spoken", so pass only long words as vocabulary, not the passage.
function vocabularyHint(passage) {
  const unique = [...new Set((passage || '').match(/\b[a-zA-Z]{5,}\b/g) || [])];
  return unique.slice(0, 30).join(', ');
}

async function transcribe(buffer, mimeType, passage) {
  const apiKey = process.env.GROQ_API_KEY;
  if (!apiKey) throw new Error('Speech recognition is not configured');
  const type = mimeType || 'audio/webm';
  const form = new FormData();
  form.append('file', new Blob([buffer], { type }), `recording.${extensionFor(type)}`);
  form.append('model', WHISPER_MODEL);
  form.append('response_format', 'verbose_json');
  form.append('language', 'en');
  form.append('timestamp_granularities[]', 'word');
  const hint = vocabularyHint(passage);
  if (hint) form.append('prompt', hint);

  const res = await fetch(GROQ_TRANSCRIBE_URL, { method: 'POST', headers: { Authorization: `Bearer ${apiKey}` }, body: form });
  const body = await res.text();
  if (!res.ok) throw new Error(`Whisper ${res.status}: ${body.slice(0, 300)}`);
  try {
    return JSON.parse(body);
  } catch {
    throw new Error(`Whisper parse error: ${body.slice(0, 200)}`);
  }
}

// Noise-only clips make Whisper invent words clustered at 0s; real speech spans the clip.
function looksHallucinated(words, durationSeconds) {
  if (!(durationSeconds > 1)) return false;
  const span = words.length
    ? Math.max(...words.map((w) => w.end || w.start || 0)) - Math.min(...words.map((w) => w.start || 0))
    : 0;
  return span < durationSeconds * 0.25;
}

module.exports = { transcribe, vocabularyHint, looksHallucinated, extensionFor };
