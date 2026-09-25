// Writes generated topic JSON (from generate-chapter-topics.cjs) into the NCERT Qdrant collection.
// Dry run by default. Idempotent (deterministic point ids). Every point carries generated_batch for one-step rollback.
// Usage: node scripts/ingest-generated-topics.cjs --dir <topics dir> --batch g8-pilot-2026-09-26 [--write]
//        node scripts/ingest-generated-topics.cjs --dir <topics dir> --batch g8-pilot-2026-09-26 --verify | --rollback
require('dotenv').config();
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const arg = (n) => { const i = process.argv.indexOf(n); return i > -1 ? process.argv[i + 1] : null; };
const DIR = arg('--dir');
const BATCH = arg('--batch');
const WRITE = process.argv.includes('--write');
const ROLLBACK = process.argv.includes('--rollback');
const COLLECTION = 'aivorah_curriculum_chunks_v1';
const URL_BASE = (process.env.QDRANT_URL || '').replace(/\/+$/, '');
const HEADERS = { 'api-key': process.env.QDRANT_API_KEY, 'Content-Type': 'application/json' };

if (!BATCH) { console.error('--batch is required'); process.exit(1); }

const q = async (method, p, body) => {
  const r = await fetch(`${URL_BASE}/collections/${COLLECTION}${p}`, { method, headers: HEADERS, body: body ? JSON.stringify(body) : undefined });
  const j = await r.json();
  if (!r.ok) throw new Error(`${method} ${p} -> ${r.status} ${JSON.stringify(j).slice(0, 200)}`);
  return j;
};

const uuidFrom = (s) => {
  const h = crypto.createHash('sha1').update(s).digest('hex');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-5${h.slice(13, 16)}-a${h.slice(17, 20)}-${h.slice(20, 32)}`;
};

function idsFromDir() {
  const ids = [];
  for (const f of fs.readdirSync(DIR).filter((x) => x.endsWith('.json') && !x.startsWith('_'))) {
    const r = JSON.parse(fs.readFileSync(path.join(DIR, f), 'utf8'));
    for (const t of r.topics) ids.push(uuidFrom(`${r.pdfFile}|${t.name}`));
  }
  return ids;
}

async function presentCount(ids) {
  let n = 0;
  for (let i = 0; i < ids.length; i += 256) {
    const r = await q('POST', '/points', { ids: ids.slice(i, i + 256), with_payload: false, with_vector: false });
    n += r.result.length;
  }
  return n;
}

async function rollback() {
  if (!DIR) throw new Error('--dir is required for rollback');
  const ids = idsFromDir();
  const before = await presentCount(ids);
  for (let i = 0; i < ids.length; i += 256) await q('POST', '/points/delete?wait=true', { points: ids.slice(i, i + 256) });
  console.log(`rollback ${BATCH}: ${before} -> ${await presentCount(ids)}`);
}


async function main() {
  if (ROLLBACK) return rollback();
  if (process.argv.includes('--verify')) { console.log(`present: ${await presentCount(idsFromDir())}/${idsFromDir().length}`); return; }
  if (!DIR) { console.error('--dir is required'); process.exit(1); }
  const { embed } = require('../../aivorah-ai-coach-service/services/embeddings');

  const info = await q('GET', '');
  const vec = info.result.config.params.vectors;
  console.log('collection vectors config:', JSON.stringify(vec));

  const files = fs.readdirSync(DIR).filter((f) => f.endsWith('.json') && !f.startsWith('_'));
  const points = [];
  for (const f of files) {
    const r = JSON.parse(fs.readFileSync(path.join(DIR, f), 'utf8'));
    const grade = Number(process.argv.includes('--grade') ? arg('--grade') : 8);
    r.topics.forEach((t, i) => {
      const text = `${t.name}\n\nKey terms: ${t.key_terms.join(', ')}\n\n${t.explanation}`;
      points.push({
        id: uuidFrom(`${r.pdfFile}|${t.name}`),
        text,
        payload: {
          curriculum: 'NCERT',
          grade,
          subject: r.subject,
          topic: t.name,
          content_type: 'explanation',
          text,
          key_terms: t.key_terms,
          source_reference: `NCERT ${r.subject} Grade ${grade} | ${r.pdfFile}`,
          source_quote: t.quote,
          topic_order: i + 1,
          generated_by: 'llm-grounded',
          generated_batch: BATCH,
        },
      });
    });
  }
  console.log(`points prepared: ${points.length} from ${files.length} chapters`);

  const withVectors = [];
  let n = 0;
  for (const p of points) {
    const vector = await embed(p.text);
    if (vector.length !== (vec.size || 384)) throw new Error(`unexpected vector length ${vector.length}`);
    withVectors.push({ id: p.id, vector, payload: p.payload });
    if (++n % 200 === 0) console.log(`embedded ${n}/${points.length}`);
  }
  console.log(`embedded all ${withVectors.length}; sample payload:`, JSON.stringify(withVectors[0].payload).slice(0, 300));
  if (!WRITE) { console.log('DRY RUN: nothing written. Re-run with --write.'); return; }

  for (let i = 0; i < withVectors.length; i += 64) {
    await q('PUT', '/points?wait=true', { points: withVectors.slice(i, i + 64) });
  }
  console.log(`written. ${await presentCount(withVectors.map((p) => p.id))}/${withVectors.length} points present in Qdrant`);
}

main().catch((e) => { console.error(e); process.exit(1); });
