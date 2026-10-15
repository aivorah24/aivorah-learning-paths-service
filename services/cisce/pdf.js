// Download/validate + extract stages for one PDF.
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFile, fork } = require('child_process');
const { promisify } = require('util');
const { sha256 } = require('./ids');

const run = promisify(execFile);
// A page with fewer visible characters than this is treated as scanned.
const SCANNED_PAGE_MIN_CHARS = 40;

const WORKER = path.join(__dirname, 'pdfWorker.js');
const PARSE_TIMEOUT_MS = 180000;

/**
 * Parses a PDF in a child process (see pdfWorker.js), returning one text
 * string per page, in order. Throws if unparseable or if parsing hangs.
 */
function parsePages(buffer, { timeoutMs = PARSE_TIMEOUT_MS } = {}) {
  return new Promise((resolve, reject) => {
    const child = fork(WORKER, [], { stdio: ['ignore', 'ignore', 'ignore', 'ipc'] });
    let settled = false;
    const finish = (fn, v) => { if (!settled) { settled = true; clearTimeout(timer); fn(v); } };
    const timer = setTimeout(() => { child.kill('SIGKILL'); finish(reject, new Error(`unparseable PDF: parse timed out after ${timeoutMs}ms`)); }, timeoutMs);
    child.on('message', (m) => (m.ok ? finish(resolve, { pageCount: m.pageCount, pages: m.pages }) : finish(reject, new Error(m.error))));
    child.on('error', (err) => finish(reject, err));
    child.on('exit', (code) => finish(reject, new Error(`unparseable PDF: parser exited with code ${code}`)));
    child.send({ base64: Buffer.from(buffer).toString('base64') });
  });
}

/**
 * Real-PDF check: non-empty, "%PDF-" header in the first 1 KiB (the spec
 * allows leading junk), not an HTML error page, and parseable with ≥1 page.
 */
async function validatePdf(buffer) {
  if (!buffer || buffer.length === 0) return { ok: false, reason: 'EMPTY' };
  const head = buffer.subarray(0, 1024).toString('latin1');
  if (/^\s*(<!doctype html|<html)/i.test(head)) return { ok: false, reason: 'HTML_NOT_PDF' };
  if (!head.includes('%PDF-')) return { ok: false, reason: 'NO_PDF_HEADER' };
  try {
    const { pageCount } = await parsePages(buffer);
    if (!pageCount) return { ok: false, reason: 'ZERO_PAGES' };
    return { ok: true, pageCount };
  } catch (err) {
    return { ok: false, reason: 'UNPARSEABLE', detail: err.message };
  }
}

/**
 * Fetches one registry source and records what came back on it. The PDF
 * itself goes to the local cache only (never committed, never uploaded here).
 */
async function downloadSource(source, http, { cacheDir, now = () => new Date().toISOString() }) {
  const res = await http.get(source.url);
  Object.assign(source, {
    http_status: res.status,
    final_url: res.finalUrl,
    content_type: res.contentType,
    checked_at: now(),
    checked_from: 'local-cli',
  });
  if (!res.ok) {
    source.link_status = res.status === 404 || res.status === 410 ? 'DEAD' : 'UNREACHABLE';
    return { ok: false, reason: `HTTP_${res.status}${res.error ? ` ${res.error}` : ''}` };
  }
  const check = await validatePdf(res.body);
  source.bytes = res.body.length;
  source.sha256 = sha256(res.body);
  if (!check.ok) {
    source.link_status = 'INVALID_PDF';
    source.page_count = null;
    return { ok: false, reason: check.reason };
  }
  source.page_count = check.pageCount;
  source.link_status = 'VERIFIED';
  const file = pdfPath(cacheDir, source);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, res.body);
  return { ok: true, file };
}

const pdfPath = (cacheDir, source) => path.join(cacheDir, 'sources', source.id, `${source.sha256}.pdf`);

async function commandExists(cmd) {
  try {
    if (process.platform === 'win32') await run('where', [cmd]);
    else await run('sh', ['-c', `command -v ${cmd}`]);
    return true;
  } catch {
    return false;
  }
}

// OCR one page with poppler's pdftoppm + tesseract, when both are installed.
async function tesseractOcr(pdfFile, pageNumber) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cisce-ocr-'));
  try {
    const prefix = path.join(dir, 'p');
    await run('pdftoppm', ['-f', String(pageNumber), '-l', String(pageNumber), '-r', '300', '-png', '-singlefile', pdfFile, prefix]);
    const { stdout } = await run('tesseract', [`${prefix}.png`, 'stdout', '-l', 'eng'], { maxBuffer: 16 * 1024 * 1024 });
    return stdout;
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

async function defaultOcr() {
  return (await commandExists('pdftoppm')) && (await commandExists('tesseract')) ? tesseractOcr : null;
}

/**
 * Text per page; OCR runs only on pages with (almost) no extractable text.
 * Without an OCR engine those pages are kept as method "none" and warned
 * about — never filled in.
 */
async function extractPdf(pdfFile, { ocr, minChars = SCANNED_PAGE_MIN_CHARS } = {}) {
  const buffer = fs.readFileSync(pdfFile);
  const { pageCount, pages } = await parsePages(buffer);
  const ocrFn = ocr === undefined ? await defaultOcr() : ocr;
  const out = [];
  const warnings = [];
  for (let i = 0; i < pageCount; i++) {
    const text = (pages[i] || '').trim();
    if (text.replace(/\s/g, '').length >= minChars) {
      out.push({ page: i + 1, method: 'text', text });
      continue;
    }
    if (ocrFn) {
      try {
        const t = String(await ocrFn(pdfFile, i + 1)).trim();
        out.push({ page: i + 1, method: t ? 'ocr' : 'none', text: t });
        if (!t) warnings.push(`page ${i + 1}: OCR found no text`);
        continue;
      } catch (err) {
        warnings.push(`page ${i + 1}: OCR failed (${err.message})`);
      }
    } else {
      warnings.push(`page ${i + 1}: scanned/empty and no OCR engine (install poppler-utils + tesseract)`);
    }
    out.push({ page: i + 1, method: 'none', text });
  }
  const count = (m) => out.filter((p) => p.method === m).length;
  return {
    sha256: sha256(buffer),
    pageCount,
    pages: out,
    textPages: count('text'),
    ocrPages: count('ocr'),
    emptyPages: count('none'),
    warnings,
  };
}

module.exports = { validatePdf, parsePages, downloadSource, extractPdf, pdfPath, tesseractOcr, SCANNED_PAGE_MIN_CHARS };
