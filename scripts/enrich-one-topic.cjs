// Builds ONE grade-level, visual Learn-tab lesson with Gemini using the service's own prompt + validators,
// and (with --write) saves it to topic_ai_enrichment so the app serves it instantly.
// Usage: node scripts/enrich-one-topic.cjs --grade 8 --subject English --topic "Camel's Tail Length" \
//          --env-file ../aivorah-students-service/.env --keywords tail,mosquito,blood [--write]
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const dotenv = require('dotenv');

const arg = (n) => { const i = process.argv.indexOf(n); return i > -1 ? process.argv[i + 1] : null; };
const ENV_FILE = arg('--env-file');
if (ENV_FILE) {
  const e = dotenv.parse(fs.readFileSync(path.resolve(ENV_FILE)));
  process.env.SUPABASE_URL = e.SUPABASE_URL;
  process.env.SUPABASE_SERVICE_KEY = e.SUPABASE_SERVICE_KEY || e.SUPABASE_SERVICE_ROLE_KEY;
}
require('dotenv').config();

const GRADE = `Grade ${arg('--grade') || 8}`;
const SUBJECT = arg('--subject');
const TOPIC = arg('--topic');
const KEYWORDS = (arg('--keywords') || '').split(',').filter(Boolean);
const WRITE = process.argv.includes('--write');
const CURRICULUM = 'CBSE';
const MODELS = ['gemini-3-flash-preview', 'gemini-flash-lite-latest'];

const supabase = require('../services/supabase');
const qd = require('../services/qdrant');
const { buildPrompt, classifyContentType, checkRecipe } = require('../services/curriculum/enrichment');
const { validateEnrichment } = require('../services/curriculum/blockSchema');

const VISUAL_EMPHASIS = `

VISUAL EMPHASIS FOR THIS LESSON: the student is in ${GRADE}. Make the lesson VISUAL and easy to follow:
- Include a "process" block (numbered clue-by-clue reasoning steps) AND a "cause_and_effect" block or a "comparison"/"table" block that lays the ideas side by side.
- Keep every sentence short and in plain words a ${GRADE} student uses; explain any harder word right where it appears.
- Use ONLY facts present in the SOURCE TEXT and CONTEXT TEXT; do not invent story details.`;

async function callGemini(prompt) {
  let lastErr;
  for (const model of MODELS) {
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const r = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`, {
        method: 'POST',
        headers: { 'x-goog-api-key': process.env.GEMINI_API_KEY, 'Content-Type': 'application/json' },
        body: JSON.stringify({ contents: [{ parts: [{ text: prompt }] }], generationConfig: { responseMimeType: 'application/json', temperature: 0.3 } }),
        signal: AbortSignal.timeout(180000),
      });
      const j = await r.json();
      if (r.ok) return { model, text: j.candidates?.[0]?.content?.parts?.map((p) => p.text).join('') || '' };
      lastErr = `${model} ${r.status}`;
      if (r.status === 429 || r.status === 503) await new Promise((res) => setTimeout(res, 15000));
      else break;
    }
  }
  throw new Error(`Gemini unavailable (${lastErr})`);
}

function chapterPassage(pdfFile) {
  const cache = path.join(process.env.NCERT_CHAPTER_CACHE || os.tmpdir(), pdfFile);
  if (!fs.existsSync(cache)) return '';
  const text = spawnSync('pdftotext', [cache, '-'], { encoding: 'utf8', maxBuffer: 1 << 26 }).stdout || '';
  const paras = text.replace(/\r/g, '').split(/\n\s*\n/).map((p) => p.replace(/\s+/g, ' ').trim()).filter((p) => p.length > 40);
  const hits = paras.map((p, i) => ({ i, score: KEYWORDS.filter((k) => p.toLowerCase().includes(k.toLowerCase())).length })).filter((h) => h.score > 0);
  const keep = new Set();
  for (const h of hits) { keep.add(h.i - 1); keep.add(h.i); keep.add(h.i + 1); }
  return [...keep].filter((i) => i >= 0 && i < paras.length).sort((a, b) => a - b).map((i) => paras[i]).join('\n\n').slice(0, 5000);
}

async function main() {
  const retrieved = await qd.resolveTopicWithContext(CURRICULUM, GRADE, SUBJECT, TOPIC);
  if (!retrieved || !retrieved.primary.length) throw new Error('topic not found in Qdrant');
  const passage = retrieved.pdfFile ? chapterPassage(retrieved.pdfFile) : '';
  console.log(`topic found; chapter ${retrieved.pdfFile}; textbook passage for grounding: ${passage.length} chars`);

  const input = {
    curriculum: CURRICULUM, grade: GRADE, subject: SUBJECT, topic: TOPIC,
    contentType: classifyContentType(SUBJECT), chapterPdf: retrieved.pdfFile,
    primaryText: retrieved.primary.map((c) => c.text).join('\n\n'),
    contextText: [passage, ...retrieved.context.map((c) => c.text)].filter(Boolean).join('\n\n'),
  };
  let prompt = buildPrompt(input) + VISUAL_EMPHASIS;

  let result;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const { model, text } = await callGemini(prompt);
    let parsed;
    try { parsed = JSON.parse(text); } catch { prompt += '\n\nYour previous response was not valid JSON. Respond with ONLY the JSON object.'; continue; }
    const v = validateEnrichment(parsed);
    if (!v.valid) { prompt += `\n\nYour previous response was invalid: ${v.errors.join('; ')}. Fix it and respond with ONLY the corrected JSON object.`; continue; }
    const missing = checkRecipe(v.blocks);
    if (missing.length && attempt < 2) { prompt += `\n\nYour previous response was missing: ${missing.join('; ')}. Respond with the FULL corrected JSON.`; continue; }
    result = { model, whatYoullLearn: parsed.whatYoullLearn, blocks: v.blocks, missing };
    break;
  }
  if (!result) throw new Error('could not get a valid lesson from Gemini');

  console.log(`generated with ${result.model}; blocks: ${result.blocks.map((b) => b.type).join(', ')}; recipe gaps: ${result.missing.length ? result.missing.join('; ') : 'none'}`);
  fs.writeFileSync(path.join(os.tmpdir(), 'enrich-one-topic.json'), JSON.stringify(result, null, 1));
  console.log(JSON.stringify({ whatYoullLearn: result.whatYoullLearn, blocks: result.blocks }, null, 1));
  if (!WRITE) { console.log('\nDRY RUN: not saved. Re-run with --write to save.'); return; }

  const { error } = await supabase.from('topic_ai_enrichment').upsert({
    curriculum: CURRICULUM, grade: GRADE, subject: SUBJECT, topic: TOPIC,
    content_type: input.contentType,
    structured_content: { whatYoullLearn: result.whatYoullLearn, blocks: result.blocks },
    source_chunk_ids: retrieved.primary.map((c) => c.id),
    source_reference: retrieved.sourceReference || null,
    schema_version: 1, prompt_version: 'v1-visual-gemini', model: result.model,
    updated_at: new Date().toISOString(),
  }, { onConflict: 'curriculum,grade,subject,topic' });
  if (error) throw new Error(`save failed: ${error.message}`);
  console.log('\nSAVED to topic_ai_enrichment.');
}

main().catch((e) => { console.error(e.message); process.exitCode = 1; });
