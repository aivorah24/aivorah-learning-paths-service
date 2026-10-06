// Uploads NCERT chapter PDFs that are missing on Cloudinary (ncert_books/<bookPath>) so the app's "View in Book" pane opens.
// Dry run by default. Additive only: never overwrites an existing file.
// Usage: node scripts/upload-missing-books.cjs --grades 8 [--write] [--shrink] [--out <report.json>]
require('dotenv').config();
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const cloudinary = require('cloudinary').v2;
const sm = require('../services/syllabus-map');

const arg = (n) => { const i = process.argv.indexOf(n); return i > -1 ? process.argv[i + 1] : null; };
const GRADES = (arg('--grades') || '1,2,3,4,5,6,7,8,9,10,11,12').split(',').map(Number);
const WRITE = process.argv.includes('--write');
const SHRINK = process.argv.includes('--shrink');
const OUT = arg('--out');
const MAX_BYTES = 10 * 1024 * 1024; // Cloudinary free plan raw-file limit
const CLOUD = process.env.CLOUDINARY_CLOUD_NAME;
const TMP = path.join(os.tmpdir(), 'ncert-book-upload');
fs.mkdirSync(TMP, { recursive: true });
cloudinary.config({ cloud_name: CLOUD, api_key: process.env.CLOUDINARY_API_KEY, api_secret: process.env.CLOUDINARY_API_SECRET });

const urlFor = (bookPath) => `https://res.cloudinary.com/${CLOUD}/raw/upload/ncert_books/${bookPath}`;
const exists = async (bookPath) => {
  try { return (await fetch(urlFor(bookPath), { method: 'HEAD', signal: AbortSignal.timeout(20000) })).status === 200; } catch { return false; }
};

async function download(pdfFile) {
  for (let a = 0; a < 4; a += 1) {
    try {
      const r = await fetch(`https://ncert.nic.in/textbook/pdf/${pdfFile}`, { signal: AbortSignal.timeout(120000) });
      if (r.ok) return Buffer.from(await r.arrayBuffer());
    } catch { /* retry */ }
    await new Promise((r) => setTimeout(r, 2000));
  }
  return null;
}

async function main() {
  const items = [];
  for (const g of GRADES) {
    for (const { subject } of sm.subjectsFor(`Grade ${g}`)) {
      const seen = new Set();
      for (const c of sm.chaptersFor(g, subject)) {
        if (seen.has(c.chapter)) continue;
        seen.add(c.chapter);
        if (c.bookPath && c.pdfFile) items.push({ g, subject, pdfFile: c.pdfFile, bookPath: c.bookPath });
      }
    }
  }
  const missing = [];
  let i = 0;
  await Promise.all(Array.from({ length: 10 }, async () => {
    while (i < items.length) { const it = items[i++]; if (!(await exists(it.bookPath))) missing.push(it); }
  }));
  missing.sort((a, b) => a.bookPath.localeCompare(b.bookPath));
  console.log(`chapters checked: ${items.length}; missing on Cloudinary: ${missing.length}${WRITE ? '' : ' (DRY RUN)'}`);

  const report = { uploaded: [], skipped: [], failed: [] };
  if (WRITE) {
    for (const it of missing) {
      const buf = await download(it.pdfFile);
      if (!buf || buf.length < 1000 || buf.slice(0, 4).toString() !== '%PDF') { report.failed.push({ ...it, reason: 'download-failed-or-not-pdf' }); console.log(`FAIL ${it.bookPath}: download`); continue; }
      const file = path.join(TMP, it.pdfFile);
      let body = buf;
      if (buf.length > MAX_BYTES) {
        if (!SHRINK) { report.skipped.push({ ...it, reason: `too-large ${(buf.length / 1048576).toFixed(1)}MB` }); console.log(`SKIP ${it.bookPath}: ${(buf.length / 1048576).toFixed(1)}MB > 10MB (use --shrink)`); continue; }
        // Display-only copy: pages re-rendered as compressed images (text layer not kept).
        const big = `${file}.big.pdf`;
        fs.writeFileSync(big, buf);
        const r = spawnSync('python', [path.join(__dirname, 'shrink_pdf.py'), big, file, '9.5'], { encoding: 'utf8', timeout: 600000 });
        try { fs.unlinkSync(big); } catch { /* ignore */ }
        body = fs.existsSync(file) ? fs.readFileSync(file) : null;
        if (r.status !== 0 || !body || body.length > MAX_BYTES) { report.failed.push({ ...it, reason: 'shrink-failed' }); console.log(`FAIL ${it.bookPath}: could not shrink under 10MB`); continue; }
        console.log(`shrunk ${it.bookPath}: ${(buf.length / 1048576).toFixed(1)}MB -> ${(body.length / 1048576).toFixed(1)}MB`);
      }
      fs.writeFileSync(file, body);
      try {
        await cloudinary.uploader.upload(file, { resource_type: 'raw', public_id: `ncert_books/${it.bookPath}`, overwrite: false, unique_filename: false, use_filename: false });
        let ok = false;
        for (let t = 0; t < 8 && !ok; t += 1) { ok = await exists(it.bookPath); if (!ok) await new Promise((r) => setTimeout(r, 8000)); } // CDN can lag a few seconds
        (ok ? report.uploaded : report.failed).push(ok ? it : { ...it, reason: 'uploaded-but-not-reachable' });
        console.log(`${ok ? 'OK  ' : 'FAIL'} ${it.bookPath} (${(body.length / 1048576).toFixed(1)}MB)`);
      } catch (e) {
        report.failed.push({ ...it, reason: String(e.message || e).slice(0, 120) });
        console.log(`FAIL ${it.bookPath}: ${String(e.message || e).slice(0, 100)}`);
      } finally { try { fs.unlinkSync(file); } catch { /* ignore */ } }
    }
    console.log(`\nuploaded ${report.uploaded.length}, skipped ${report.skipped.length}, failed ${report.failed.length}`);
  } else {
    const by = {};
    for (const m of missing) by[`G${m.g} ${m.subject}`] = (by[`G${m.g} ${m.subject}`] || 0) + 1;
    console.log(Object.entries(by).map(([k, v]) => `${k}: ${v}`).join('\n'));
  }
  if (OUT) fs.writeFileSync(OUT, JSON.stringify(WRITE ? report : { missing }, null, 1));
}

main().catch((e) => { console.error(e); process.exit(1); });
