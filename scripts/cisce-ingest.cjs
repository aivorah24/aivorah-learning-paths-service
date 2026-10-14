#!/usr/bin/env node
/**
 * Official CISCE curriculum ingestion CLI.
 *
 *   node scripts/cisce-ingest.cjs run [flags]        all stages (discover → … → index, then coverage)
 *   node scripts/cisce-ingest.cjs coverage [flags]   coverage report only, from what is already extracted
 *   node scripts/cisce-ingest.cjs registry           registry summary
 *
 * Flags:
 *   --dry-run            read from cisce.org and the local cache only; no Supabase/Qdrant/Cloudinary writes
 *   --resume             skip stages already done for the same file (sha256)
 *   --source <id,...>    only these registry source ids
 *   --stage <x,...>      only these stages: discover,download,extract,normalise,validate,persist,index,store,coverage
 *   --concurrency N      sources processed in parallel (default 2; cisce.org requests stay ≥1s apart regardless)
 *   --check-supplementary  read existing AI-generated ICSE rows (read-only) so coverage can mark SUPPLEMENTARY_ONLY
 *   --store-pdfs         allow the store stage (also needs CISCE_CLOUDINARY_APPROVED_BY)
 *   --cache-dir <dir>    local cache for PDFs/extractions/state (default .cisce-cache)
 *   --log-file <file>    also append log lines to this file
 *
 * Writes (persist/index) only ever go to the Dev Supabase project; see services/cisce/guard.js.
 */
require('dotenv').config();
const fs = require('fs');
const path = require('path');
const { runPipeline } = require('../services/cisce/pipeline');
const { loadRegistry, summarise } = require('../services/cisce/registry');
const { createHttp } = require('../services/cisce/http');

function parseArgs(argv) {
  const args = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith('--')) { args._.push(a); continue; }
    const [k, inline] = a.slice(2).split('=');
    const flag = ['dry-run', 'resume', 'check-supplementary', 'store-pdfs', 'help'].includes(k);
    args[k] = flag ? true : (inline ?? argv[++i]);
  }
  return args;
}

function makeLogger(file) {
  if (file) fs.mkdirSync(path.dirname(path.resolve(file)), { recursive: true });
  return (msg) => {
    const line = `[${new Date().toISOString()}] ${msg}`;
    console.log(line);
    if (file) fs.appendFileSync(file, `${line}\n`);
  };
}

// Last-resort guard for an unattended run: PDF parsing is already isolated
// in a child process (services/cisce/pdfWorker.js), so anything reaching
// here is unexpected — log it rather than lose the night's progress.
process.on('unhandledRejection', (reason) => {
  console.error(`[${new Date().toISOString()}] ignored unhandled rejection: ${reason && reason.message ? reason.message : reason}`);
});

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const cmd = args._[0] || 'run';
  if (args.help) {
    console.log(fs.readFileSync(__filename, 'utf8').split('*/')[0]);
    return 0;
  }
  if (cmd === 'registry') {
    console.log(JSON.stringify(summarise(loadRegistry()), null, 2));
    return 0;
  }
  if (!['run', 'coverage'].includes(cmd)) throw new Error(`unknown command "${cmd}"`);

  const log = makeLogger(args['log-file']);
  const stages = cmd === 'coverage' ? 'coverage' : args.stage;
  const needsDb = !args['dry-run'] && /persist/.test(stages || 'persist') || args['check-supplementary'];
  const needsQdrant = !args['dry-run'] && /index/.test(stages || 'index');
  const deps = {
    http: createHttp(),
    db: needsDb ? require('../services/supabase') : null,
    qdrant: null,
    embed: null,
    uploadPrivateFile: require('../services/curriculumUpload/cloudinaryStorage').uploadPrivateFile,
  };
  if (needsQdrant) {
    const { QdrantClient } = require('@qdrant/js-client-rest');
    deps.qdrant = new QdrantClient({ url: process.env.QDRANT_URL, apiKey: process.env.QDRANT_API_KEY });
    deps.embed = require('../services/cisce/indexer').defaultEmbed;
  }

  const result = await runPipeline({
    stages,
    dryRun: !!args['dry-run'],
    resume: !!args.resume,
    sourceIds: args.source ? String(args.source).split(',').map((s) => s.trim()) : undefined,
    concurrency: args.concurrency ? parseInt(args.concurrency, 10) : 2,
    cacheDir: args['cache-dir'],
    storePdfs: !!args['store-pdfs'],
    checkSupplementary: !!args['check-supplementary'],
    log,
  }, deps);

  const failures = Object.entries(result.failures);
  log(`done ${result.runId}: ${Object.keys(result.processed).length} processed, ${failures.length} failed, ${result.documents.length} validated document(s)`);
  for (const [id, f] of failures) log(`  failed ${id} at ${f.stage}: ${f.reason}`);
  if (result.dryRun && result.planned.length) log(`dry run — would have done: ${JSON.stringify(result.planned.slice(0, 20))}${result.planned.length > 20 ? ' …' : ''}`);
  if (result.coverage) log(`coverage: ${JSON.stringify(result.coverage.summary)}`);
  // Exit 2 = finished with per-source failures (the overnight runner retries those with --resume).
  return failures.length ? 2 : 0;
}

main().then((code) => process.exit(code)).catch((err) => {
  console.error(`fatal: ${err.message}`);
  process.exit(1);
});
