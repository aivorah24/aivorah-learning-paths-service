// Pre-builds the grade-level rich lesson (Learn tab blocks) for every topic of a grade, so students never wait on the LLM.
// Uses the service's own getOrGenerateEnrichment (grade calibration, validation) and saves to topic_ai_enrichment.
// Resumable: topics already saved are skipped. Stops after repeated failures (LLM quota) — just re-run later.
// Usage: node scripts/prebuild-enrichment.cjs --grade 8 --env-file ../aivorah-students-service/.env [--subject Science] [--limit 50] [--gap-ms 12000] [--dry]
const fs = require('fs');
const path = require('path');
const dotenv = require('dotenv');

const arg = (n) => { const i = process.argv.indexOf(n); return i > -1 ? process.argv[i + 1] : null; };
// The live service uses the Test Supabase project; take ONLY its Supabase settings from the given env file.
const ENV_FILE = arg('--env-file');
if (ENV_FILE) {
  const e = dotenv.parse(fs.readFileSync(path.resolve(ENV_FILE)));
  process.env.SUPABASE_URL = e.SUPABASE_URL;
  process.env.SUPABASE_SERVICE_KEY = e.SUPABASE_SERVICE_KEY || e.SUPABASE_SERVICE_ROLE_KEY;
}
require('dotenv').config(); // does not override the Supabase values set above

const GRADE = Number(arg('--grade') || 8);
const SUBJECT = arg('--subject');
const LIMIT = Number(arg('--limit') || 0);
const GAP_MS = Number(arg('--gap-ms') || 12000);
const DRY = process.argv.includes('--dry');
const CURRICULUM = 'CBSE'; // what the app sends; Qdrant mapping happens inside the service
const MAX_CONSECUTIVE_FAILS = 4;

const supabase = require('../services/supabase');
const sm = require('../services/syllabus-map');
const qd = require('../services/qdrant');
const { getOrGenerateEnrichment, getCachedEnrichment } = require('../services/curriculum/enrichment');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function main() {
  const probe = await supabase.from('topic_ai_enrichment').select('id').limit(1);
  if (probe.error) { console.error(`topic_ai_enrichment is not usable in this database: ${probe.error.message}\nRun db/migrations/topic_ai_enrichment.sql first.`); process.exitCode = 2; return; }

  const todo = [];
  for (const { subject } of sm.subjectsFor(`Grade ${GRADE}`)) {
    if (SUBJECT && subject !== SUBJECT) continue;
    const byFile = await qd.topicsByPdfFile(CURRICULUM, `Grade ${GRADE}`, subject);
    const seen = new Set();
    for (const c of sm.chaptersFor(GRADE, subject)) {
      if (seen.has(c.chapter)) continue;
      seen.add(c.chapter);
      for (const t of byFile.get(String(c.pdfFile || '').toLowerCase()) || []) todo.push({ subject, topic: t.name });
    }
  }
  const pending = [];
  for (const t of todo) {
    if (!(await getCachedEnrichment({ curriculum: CURRICULUM, grade: `Grade ${GRADE}`, subject: t.subject, topic: t.topic }))) pending.push(t);
  }
  console.log(`Grade ${GRADE}: ${todo.length} topics, ${todo.length - pending.length} already saved, ${pending.length} to build${DRY ? ' (DRY RUN)' : ''}`);
  if (DRY) return;

  let done = 0;
  let fails = 0;
  for (const t of (LIMIT ? pending.slice(0, LIMIT) : pending)) {
    const r = await getOrGenerateEnrichment({ curriculum: CURRICULUM, grade: `Grade ${GRADE}`, subject: t.subject, topic: t.topic });
    if (r) { done += 1; fails = 0; } else { fails += 1; }
    console.log(`[${done}/${pending.length}] ${r ? (r.cached ? 'cached' : `built ${r.blocks.map((b) => b.type).join(',')}`) : 'FAILED'} | ${t.subject} | ${t.topic}`);
    if (fails >= MAX_CONSECUTIVE_FAILS) { console.log('Too many failures in a row (LLM quota?). Stopping; re-run later to resume.'); break; }
    await sleep(GAP_MS);
  }
  console.log(`finished: built ${done}`);
}

main().catch((e) => { console.error(e); process.exit(1); });
