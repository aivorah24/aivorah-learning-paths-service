/**
 * Orchestrates the CISCE ingestion stages:
 *   discover → download (validate) → extract → normalise → validate → persist → index  (+ coverage)
 * and the opt-in "store" stage (private Cloudinary copy, needs owner approval).
 *
 * Long unattended runs: state is checkpointed to <cacheDir>/state.json after
 * every stage of every source, a failing source never stops the others, and
 * --resume skips work already done for the same file (sha256).
 */
const fs = require('fs');
const path = require('path');
const { STAGES, CURRICULUM_ID } = require('./constants');
const { loadRegistry, saveRegistry, isPdfKind, summarise, DEFAULT_REGISTRY_PATH } = require('./registry');
const { discover } = require('./discover');
const { downloadSource, extractPdf, pdfPath } = require('./pdf');
const { normalise } = require('./normalise');
const { validateCanonical } = require('./validate');
const { createWriter } = require('./persist');
const { createIndexer } = require('./indexer');
const { buildCoverage, coverageMarkdown } = require('./coverage');
const { assertDevTarget } = require('./guard');

const ALL_STAGES = [...STAGES, 'store', 'coverage'];
const DEFAULT_STAGES = [...STAGES, 'coverage'];
const CURRICULUM_KINDS = ['SYLLABUS_PDF', 'FRAMEWORK_PDF'];
const DEFAULT_CACHE_DIR = path.join(__dirname, '..', '..', '.cisce-cache');
const DEFAULT_COVERAGE_DIR = path.join(__dirname, '..', '..', 'data', 'cisce', 'reports');

const readJson = (f, fallback) => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return fallback; } };
function writeJson(file, data) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(data, null, 2)}\n`);
  fs.renameSync(tmp, file);
}

// Runs fn over items with at most n in flight.
async function pool(items, n, fn) {
  const queue = [...items];
  const workers = Array.from({ length: Math.max(1, Math.min(n, queue.length)) }, async () => {
    while (queue.length) await fn(queue.shift());
  });
  await Promise.all(workers);
}

function parseStages(stage) {
  if (!stage) return DEFAULT_STAGES;
  const list = String(stage).split(',').map((s) => s.trim()).filter(Boolean);
  const bad = list.filter((s) => !ALL_STAGES.includes(s));
  if (bad.length) throw new Error(`unknown stage(s): ${bad.join(', ')} — use ${ALL_STAGES.join(', ')}`);
  return list;
}

async function readSupplementary(db) {
  // Read-only: the existing AI-generated ICSE outline, grouped by grade/subject.
  const rows = [];
  for (let from = 0; ; from += 1000) {
    const { data, error } = await db.from('syllabus_chapters').select('grade, subject')
      .in('curriculum', ['ICSE', 'icse', 'Icse']).is('school_id', null).range(from, from + 999);
    if (error) throw new Error(`syllabus_chapters read failed: ${error.message}`);
    rows.push(...(data || []));
    if (!data || data.length < 1000) break;
  }
  const grouped = new Map();
  for (const r of rows) {
    const k = `${r.grade}\u0000${r.subject}`;
    grouped.set(k, { grade: r.grade, subject: r.subject, chapters: (grouped.get(k)?.chapters || 0) + 1 });
  }
  return [...grouped.values()];
}

/**
 * @param {object} opts  { stages, dryRun, resume, sourceIds, concurrency, registryPath, cacheDir, coverageDir, storePdfs, checkSupplementary, log }
 * @param {object} deps  { http, db, qdrant, embed, ocr, uploadPrivateFile, env, now }
 */
async function runPipeline(opts = {}, deps = {}) {
  const stages = Array.isArray(opts.stages) ? opts.stages : parseStages(opts.stages);
  const has = (s) => stages.includes(s);
  const dryRun = !!opts.dryRun;
  const log = opts.log || (() => {});
  const now = deps.now || (() => new Date().toISOString());
  const env = deps.env || process.env;
  const cacheDir = opts.cacheDir || DEFAULT_CACHE_DIR;
  const registryPath = opts.registryPath || DEFAULT_REGISTRY_PATH;
  const coverageDir = opts.coverageDir || DEFAULT_COVERAGE_DIR;
  const runId = opts.runId || `cisce-${now().replace(/[-:.TZ]/g, '').slice(0, 14)}`;
  const statePath = path.join(cacheDir, 'state.json');

  const writes = (has('persist') || has('index')) && !dryRun;
  if (writes) assertDevTarget(env);
  if (has('index') && !dryRun && !env.QDRANT_URL) throw new Error('QDRANT_URL is not set');
  if (has('store') && !dryRun && !(opts.storePdfs && env.CISCE_CLOUDINARY_APPROVED_BY)) {
    throw new Error('store stage needs --store-pdfs and CISCE_CLOUDINARY_APPROVED_BY=<who approved> — CISCE PDFs are copyrighted');
  }

  const registry = loadRegistry(registryPath);
  const state = readJson(statePath, { sources: {} });
  const saveState = () => writeJson(statePath, state);
  const writer = has('persist') ? createWriter(deps.db, { dryRun, log }) : null;
  const indexer = has('index') ? createIndexer(deps.qdrant, deps.embed, { dryRun, log }) : null;
  const result = { runId, dryRun, stages, discovered: [], processed: {}, failures: {}, documents: [], planned: [] };

  if (has('discover')) {
    const d = await discover(registry, deps.http, { log, now, only: opts.sourceIds });
    result.discovered = d.added;
    saveRegistry(registry, registryPath);
    log(`discover: ${d.added.length} new source(s); registry ${JSON.stringify(summarise(registry).byStatus)}`);
  }

  const targets = registry.sources
    .filter((s) => isPdfKind(s.kind) && s.link_status !== 'DEAD')
    .filter((s) => !opts.sourceIds || opts.sourceIds.includes(s.id));

  const perSource = async (source) => {
    const st = (state.sources[source.id] ||= { stages: {} });
    const done = (stage) => opts.resume && st.stages[stage] === 'done' && st.sha256 && (stage === 'download' || st.sha256 === source.sha256);
    const mark = (stage, status, extra = {}) => { st.stages[stage] = status; Object.assign(st, extra, { updated_at: now() }); saveState(); };
    const fail = (stage, reason) => { mark(stage, 'failed', { error: reason }); result.failures[source.id] = { stage, reason }; log(`  x ${source.id} ${stage}: ${reason}`); };
    const dir = path.join(cacheDir, 'sources', source.id);
    const extractionFile = path.join(dir, 'extraction.json');
    const canonicalFile = path.join(dir, 'canonical.json');

    if (has('download') && !(done('download') && source.sha256 && fs.existsSync(pdfPath(cacheDir, source)))) {
      const r = await downloadSource(source, deps.http, { cacheDir, now });
      saveRegistry(registry, registryPath);
      if (!r.ok) return fail('download', r.reason);
      // A changed file invalidates everything downstream of it.
      if (st.sha256 !== source.sha256) st.stages = {};
      mark('download', 'done', { sha256: source.sha256, error: null });
      log(`  ✓ ${source.id} download: ${source.page_count} page(s), ${source.bytes} bytes`);
    }
    if (!CURRICULUM_KINDS.includes(source.kind)) return; // regulations/circulars/notices: metadata only

    const pdf = source.sha256 && pdfPath(cacheDir, source);
    if (has('extract') && !done('extract')) {
      if (!pdf || !fs.existsSync(pdf)) return fail('extract', 'no downloaded PDF — run the download stage first');
      try {
        const ex = await extractPdf(pdf, { ocr: deps.ocr });
        writeJson(extractionFile, ex);
        mark('extract', 'done');
        log(`  ✓ ${source.id} extract: ${ex.textPages} text, ${ex.ocrPages} OCR, ${ex.emptyPages} empty page(s)`);
      } catch (err) {
        return fail('extract', err.message);
      }
    }
    if (has('normalise') && !done('normalise')) {
      const ex = readJson(extractionFile, null);
      if (!ex || ex.sha256 !== source.sha256) return fail('normalise', 'no extraction for this file — run the extract stage first');
      writeJson(canonicalFile, normalise(source, ex));
      mark('normalise', 'done');
    }
    const doc = readJson(canonicalFile, null);
    if (has('validate') && !done('validate')) {
      if (!doc || doc.source.sha256 !== source.sha256) return fail('validate', 'no canonical JSON for this file — run normalise first');
      const v = validateCanonical(doc);
      writeJson(path.join(dir, 'validation.json'), v);
      if (!v.valid) return fail('validate', v.errors.slice(0, 5).join('; '));
      mark('validate', 'done');
    }
    const validated = st.stages.validate === 'done' && doc && doc.source.sha256 === source.sha256;
    if (has('persist') && !done('persist')) {
      if (!validated) return fail('persist', 'document has not passed validation');
      try {
        await writer.persistDocument(doc);
        if (!dryRun) mark('persist', 'done');
      } catch (err) {
        return fail('persist', err.message);
      }
    }
    if (has('index') && !done('index')) {
      if (!validated) return fail('index', 'document has not passed validation');
      try {
        const r = await indexer.indexDocument(doc);
        result.planned.push({ op: 'qdrant-upsert', source_id: source.id, points: r.planned });
        if (!dryRun) mark('index', 'done');
      } catch (err) {
        return fail('index', err.message);
      }
    }
    if (has('store') && !done('store')) {
      if (dryRun) { result.planned.push({ op: 'cloudinary-private-upload', source_id: source.id }); return; }
      try {
        const up = await deps.uploadPrivateFile(fs.readFileSync(pdf), {
          folder: 'aivorah/cisce-official', publicId: `${source.id}-${source.sha256.slice(0, 12)}`, fileName: path.basename(source.url),
        });
        Object.assign(source, { storage: 'CLOUDINARY_PRIVATE', storage_public_id: up.publicId, storage_approved_by: env.CISCE_CLOUDINARY_APPROVED_BY });
        saveRegistry(registry, registryPath);
        mark('store', 'done');
      } catch (err) {
        return fail('store', err.message);
      }
    }
    if (stages.some((x) => x !== 'discover' && x !== 'coverage')) result.processed[source.id] = st.stages;
  };

  log(`run ${runId}: ${targets.length} PDF source(s), stages ${stages.join(',')}${dryRun ? ' (dry run)' : ''}`);
  // Documents reference their source rows, so new sources must exist first.
  if (has('persist')) await writer.persistSources(registry.sources);
  await pool(targets, opts.concurrency || 2, async (s) => {
    try { await perSource(s); } catch (err) { result.failures[s.id] = { stage: 'unknown', reason: err.message }; log(`  x ${s.id}: ${err.message}`); }
  });

  if (has('persist')) await writer.persistSources(registry.sources);

  // Validated documents and failures for coverage — read from the cache, so
  // the report reflects every run so far, not just this one.
  const allFailures = { ...result.failures };
  for (const s of registry.sources.filter((x) => CURRICULUM_KINDS.includes(x.kind))) {
    const st = state.sources[s.id];
    const doc = readJson(path.join(cacheDir, 'sources', s.id, 'canonical.json'), null);
    if (st?.stages?.validate === 'done' && doc && doc.source.sha256 === s.sha256) result.documents.push(doc);
    if (st?.stages && Object.values(st.stages).includes('failed')) {
      const stage = Object.entries(st.stages).find(([, v]) => v === 'failed')[0];
      allFailures[s.id] ||= { stage, reason: st.error };
    }
  }

  if (has('coverage')) {
    let supplementary = null;
    if (opts.checkSupplementary && deps.db) {
      try { supplementary = await readSupplementary(deps.db); } catch (err) { log(`coverage: could not read existing ICSE rows (${err.message})`); }
    }
    const report = buildCoverage({ documents: result.documents, registry: registry.sources, failures: allFailures, supplementary });
    const stamp = now().slice(0, 10);
    const context = [
      `run ${runId}${dryRun ? ' (dry run)' : ''}`,
      `sources: ${JSON.stringify(summarise(registry).byStatus)}`,
      `validated documents: ${result.documents.length}`,
    ];
    writeJson(path.join(coverageDir, `coverage-${stamp}.json`), { run_id: runId, generated_at: now(), curriculum_id: CURRICULUM_ID, ...report });
    fs.writeFileSync(path.join(coverageDir, `coverage-${stamp}.md`), coverageMarkdown(report, { generatedAt: now(), context }));
    result.coverage = report;
    if (writer) {
      await writer.persistRun({ run_id: runId, finished_at: now(), stages, dry_run: dryRun, args: { sourceIds: opts.sourceIds || null }, summary: report.summary });
      await writer.persistCoverage(runId, report.rows);
    }
  }
  if (writer) result.planned.push(...writer.planned);
  return result;
}

module.exports = { runPipeline, parseStages, pool, readSupplementary, ALL_STAGES, DEFAULT_STAGES, DEFAULT_CACHE_DIR };
