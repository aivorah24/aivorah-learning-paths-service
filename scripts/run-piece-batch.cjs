// Builds the Learn lesson (enrich-one-topic), Listen script + textbook pictures (build-piece-script) and a visual per
// Listen scene (add-scene-visuals) for every piece
// in a manifest, one after another. Resumable: a piece whose lesson row already has a listenScript is skipped unless --force.
// Usage: node scripts/run-piece-batch.cjs data/pieces/cbse-g8-english.json --env-file ../aivorah-students-service/.env
//          [--only "Title|Title"] [--force] [--redo-listen (keep Learn, rebuild Listen)] [--visuals-only]
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const dotenv = require('dotenv');

const arg = (n) => { const i = process.argv.indexOf(n); return i > -1 ? process.argv[i + 1] : null; };
const manifest = JSON.parse(fs.readFileSync(path.resolve(process.argv[2]), 'utf8'));
const ENV_FILE = arg('--env-file');
const ONLY = arg('--only') ? arg('--only').split('|') : null;
const VISUALS_ONLY = process.argv.includes('--visuals-only');
const REDO_LISTEN = process.argv.includes('--redo-listen');
const FORCE = process.argv.includes('--force');
if (ENV_FILE) {
  const e = dotenv.parse(fs.readFileSync(path.resolve(ENV_FILE)));
  process.env.SUPABASE_URL = e.SUPABASE_URL;
  process.env.SUPABASE_SERVICE_KEY = e.SUPABASE_SERVICE_KEY || e.SUPABASE_SERVICE_ROLE_KEY;
}
require('dotenv').config();
const supabase = require('../services/supabase');

const run = (script, args) => {
  const r = spawnSync('node', [path.join(__dirname, script), ...args], { encoding: 'utf8', maxBuffer: 1 << 26, timeout: 600000 });
  return { ok: r.status === 0, out: `${r.stdout || ''}${r.stderr || ''}` };
};

(async () => {
  const summary = [];
  for (const p of manifest.pieces) {
    if (ONLY && !ONLY.includes(p.title)) continue;
    const grade = `Grade ${manifest.grade}`;
    const { data } = await supabase.from('topic_ai_enrichment').select('structured_content').match({ curriculum: 'CBSE', grade, subject: manifest.subject, topic: p.topic }).maybeSingle();
    const hasScript = !!data?.structured_content?.listenScript?.length;
    const common = ['--grade', String(manifest.grade), '--subject', manifest.subject, '--topic', p.topic];
    const envArgs = ENV_FILE ? ['--env-file', ENV_FILE] : [];
    if (VISUALS_ONLY) {
      if (!hasScript) { summary.push([p.title, 'no script yet']); continue; }
      const v = run('add-scene-visuals.cjs', [...common, '--pdf', p.pdf, '--write', ...envArgs]);
      console.log(`[${p.title}] visuals: ${v.ok ? 'ok' : 'FAILED'} ${v.out.split('\n').filter((l) => /scenes:|Error|unavailable/.test(l)).join(' | ')}`);
      summary.push([p.title, v.ok ? 'ok' : 'failed at visuals']);
      continue;
    }
    if (!FORCE && !REDO_LISTEN && hasScript) { console.log(`skip (done): ${p.title}`); summary.push([p.title, 'already done']); continue; }
    let step = 'learn';
    let res = { ok: true, out: '' };
    if (FORCE || !data?.structured_content?.blocks?.length) {
      res = run('enrich-one-topic.cjs', [...common, '--keywords', p.keywords, '--write', ...envArgs]);
      console.log(`[${p.title}] learn: ${res.ok ? 'ok' : 'FAILED'} ${res.ok ? '' : res.out.split('\n').slice(-3).join(' | ')}`);
    }
    if (res.ok) {
      step = 'listen';
      res = run('build-piece-script.cjs', [...common, '--pdf', p.pdf, '--pages', p.pages, '--type', p.type, '--title', p.title, '--unit', p.unit, '--book', manifest.book, '--write', ...envArgs]);
      console.log(`[${p.title}] listen: ${res.ok ? 'ok' : 'FAILED'}\n  ${res.out.split('\n').filter((l) => /kept|script:|pictures|SAVED|dropped|Error|unavailable/.test(l)).join('\n  ')}`);
    }
    if (res.ok) {
      step = 'visuals';
      res = run('add-scene-visuals.cjs', [...common, '--pdf', p.pdf, '--write', ...envArgs]);
      console.log(`[${p.title}] visuals: ${res.ok ? 'ok' : 'FAILED'}\n  ${res.out.split('\n').filter((l) => /scenes:|dropped|Error|unavailable/.test(l)).join('\n  ')}`);
    }
    summary.push([p.title, res.ok ? 'ok' : `failed at ${step}`]);
  }
  console.log('\nSUMMARY');
  for (const [t, s] of summary) console.log(`  ${s.padEnd(20)} ${t}`);
})().catch((e) => { console.error(e); process.exitCode = 1; });
