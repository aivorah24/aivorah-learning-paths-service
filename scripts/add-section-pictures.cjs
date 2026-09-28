// Adds the book's own pictures to every built section's Learn lesson (no AI): up to 2 of the largest colour pictures
// from the section's pages, uploaded to Cloudinary and placed after the 1st and 3rd text blocks with a page caption.
// Skips sections that already have a book picture. Usage:
//   node scripts/add-section-pictures.cjs --env-file ../aivorah-students-service/.env [--grades 8] [--limit 5] [--write]
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
const supabase = require('../services/supabase');
const cloudinary = require('cloudinary').v2;
cloudinary.config({ cloud_name: process.env.CLOUDINARY_CLOUD_NAME, api_key: process.env.CLOUDINARY_API_KEY, api_secret: process.env.CLOUDINARY_API_SECRET });

const ROOT = path.join(__dirname, '..');
const CACHE = process.env.NCERT_CHAPTER_CACHE || os.tmpdir();
const WRITE = process.argv.includes('--write');
const GRADES = arg('--grades') ? arg('--grades').split(',').map(Number) : null;
const LIMIT = Number(arg('--limit') || 0);
const BOOKS = 'https://aivorah-auth-service-g27s.onrender.com/data/ncert_books/';

const paths = {};
for (const f of fs.readdirSync(path.join(ROOT, 'data', 'curricula')).filter((x) => x.endsWith('-chapters.json'))) {
  for (const c of JSON.parse(fs.readFileSync(path.join(ROOT, 'data', 'curricula', f), 'utf8')).chapters || []) paths[c.pdfFile] = c.bookPath;
}

async function pdfFor(pdf) {
  const p = path.join(CACHE, pdf);
  if (fs.existsSync(p) && fs.statSync(p).size > 1000) return p;
  if (!paths[pdf]) return null;
  const r = await fetch(BOOKS + paths[pdf], { signal: AbortSignal.timeout(180000) }).catch(() => null);
  if (!r || !r.ok) return null;
  fs.writeFileSync(p, Buffer.from(await r.arrayBuffer()));
  return p;
}

// Largest colour picture per page in the range: [{ page, idx, area }] biggest first.
function pictures(file, from, to) {
  const list = spawnSync('pdfimages', ['-list', '-f', String(from), '-l', String(to), file], { encoding: 'utf8', maxBuffer: 1 << 26 }).stdout || '';
  const best = {};
  const seen = {};
  for (const ln of list.split('\n').slice(2)) {
    const c = ln.trim().split(/\s+/);
    if (c.length < 10) continue;
    const page = Number(c[0]);
    const idx = (seen[page] = (seen[page] ?? -1) + 1);
    if (c[2] !== 'image' || !/rgb|cmyk/.test(c[5])) continue;
    const w = Number(c[3]); const h = Number(c[4]);
    if (w < 500 || h < 300 || w / h > 5 || h / w > 3) continue;
    if (!best[page] || w * h > best[page].area) best[page] = { page, idx, area: w * h };
  }
  return Object.values(best).sort((a, b) => b.area - a.area);
}

async function upload(file, pdf, pic) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'secpic-'));
  spawnSync('pdfimages', ['-png', '-f', String(pic.page), '-l', String(pic.page), file, path.join(tmp, 'p')]);
  const png = path.join(tmp, `p-${String(pic.idx).padStart(3, '0')}.png`);
  if (!fs.existsSync(png)) return null;
  const up = await cloudinary.uploader.upload(png, { public_id: `aivorah/book-images/${pdf.replace('.pdf', '')}-p${pic.page}-${pic.idx}`, overwrite: true });
  return up.secure_url.replace('/upload/', '/upload/f_auto,q_auto,w_1000/');
}

(async () => {
  let q = supabase.from('unit_content_sections').select('id, grade, subject, pdf_file, section_title, page_from, page_to, learn').order('grade');
  if (GRADES) q = q.in('grade', GRADES);
  const { data, error } = await q;
  if (error) throw new Error(error.message);
  let n = 0; let added = 0; let none = 0;
  for (const row of data) {
    if (LIMIT && n >= LIMIT) break;
    const blocks = row.learn?.blocks || [];
    if (!blocks.length || blocks.some((b) => b.type === 'image' && /book-images/.test(b.url || ''))) continue;
    n += 1;
    const file = await pdfFor(row.pdf_file);
    if (!file) { console.log(`${row.pdf_file}: PDF missing`); continue; }
    const pics = pictures(file, row.page_from || 1, Math.max(row.page_from || 1, row.page_to || row.page_from || 1)).slice(0, 2);
    if (!pics.length) { none += 1; continue; }
    const imgs = [];
    for (const pic of pics.sort((a, b) => a.page - b.page)) {
      const url = WRITE ? await upload(file, row.pdf_file, pic).catch(() => null) : `(page ${pic.page})`;
      if (url) imgs.push({ type: 'image', url, caption: /hindi|sanskrit/i.test(row.subject) ? `पुस्तक से, पृष्ठ ${pic.page}` : /urdu/i.test(row.subject) ? `کتاب سے، صفحہ ${pic.page}` : `From the book, page ${pic.page}.` });
    }
    const out = [];
    let text = 0;
    for (const b of blocks) {
      out.push(b);
      text += 1;
      if (imgs.length && (text === 1 || text === 3)) out.push(imgs.shift());
    }
    out.push(...imgs);
    added += out.length - blocks.length;
    if (WRITE) {
      const { error: e2 } = await supabase.from('unit_content_sections').update({ learn: { ...row.learn, blocks: out }, updated_at: new Date().toISOString() }).eq('id', row.id);
      if (e2) { console.log(`${row.pdf_file}: ${e2.message}`); continue; }
    }
    console.log(`G${row.grade} ${row.subject} ${row.pdf_file} "${String(row.section_title).slice(0, 40)}": +${out.length - blocks.length} book picture(s)`);
  }
  console.log(`DONE: ${n} sections checked, ${added} pictures added, ${none} sections had no picture on their pages`);
})().catch((e) => { console.error(e.message); process.exitCode = 1; });
