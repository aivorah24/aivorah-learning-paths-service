// Builds data/book-catalog.json: which NCERT books have lessons in Qdrant (current) and which are superseded editions.
// Read-only against Qdrant. Usage: node scripts/build-book-catalog.cjs [--write]
require('dotenv').config();
const fs = require('fs');
const path = require('path');
const { topicsByPdfFile } = require('../services/qdrant');

const DIR = path.join(__dirname, '..', 'data', 'curricula');
const OUT = path.join(__dirname, '..', 'data', 'book-catalog.json');
// NCERT replaced its textbooks in Grades 6-8 (2024-26); higher grades run several books side by side.
const SWITCH_GRADES = new Set([6, 7, 8]);
// Book names read off each book's title page (Hindi names decoded from the OCR'd prelims).
const TITLES = {
  hecu1: 'Curiosity', hepr1: 'Poorvi', hegp1: 'Ganita Prakash, Part 1', hegp2: 'Ganita Prakash, Part 2',
  hees1: 'Exploring Society: India and Beyond, Part 1', hees2: 'Exploring Society: India and Beyond, Part 2',
  hekr1: 'Kriti', hehd1: 'Honeydew', hesc1: 'Science', hemh1: 'Mathematics',
  hhvs1: 'वसंत', hhdv1: 'दूर्वा', hhbk1: 'भारत की खोज',
};
const ORDER = ['hhvs1', 'hhdv1', 'hhbk1']; // Hindi: main reader first
const stem = (code) => String(code).replace(/\d+$/, '');

async function main() {
  const books = [];
  for (const f of fs.readdirSync(DIR).filter((x) => x.endsWith('-chapters.json')).sort()) {
    const j = JSON.parse(fs.readFileSync(path.join(DIR, f), 'utf8'));
    const grade = parseInt(String(j.grade).replace(/\D/g, ''), 10);
    if (!grade || !j.code) continue;
    books.push({ file: f, code: j.code, grade, subject: j.subject, chapters: j.chapters });
  }
  const cache = new Map();
  for (const b of books) {
    const key = `${b.grade}|${b.subject}`;
    if (!cache.has(key)) cache.set(key, await topicsByPdfFile('CBSE', `Grade ${b.grade}`, b.subject).catch(() => new Map()));
    const m = cache.get(key);
    b.withLessons = b.chapters.filter((c) => (m.get(String(c.pdfFile || '').toLowerCase()) || []).length).length;
  }
  const catalog = {};
  for (const b of books) {
    const siblings = books.filter((x) => x.grade === b.grade && x.subject === b.subject && x.code !== b.code);
    const coveredSiblingSameSeries = siblings.some((x) => x.withLessons > 0 && stem(x.code) === stem(b.code));
    const anyCovered = siblings.some((x) => x.withLessons > 0) || b.withLessons > 0;
    const superseded = SWITCH_GRADES.has(b.grade) && b.withLessons === 0 && anyCovered && !coveredSiblingSameSeries;
    catalog[b.code] = { ...(TITLES[b.code] ? { title: TITLES[b.code] } : {}), ...(ORDER.includes(b.code) ? { rank: ORDER.indexOf(b.code) + 1 } : {}), grade: b.grade, subject: b.subject, chapters: b.chapters.length, withLessons: b.withLessons, hidden: superseded };
  }
  return catalog;
}

main().then((c) => {
  if (process.argv.includes('--write')) fs.writeFileSync(OUT, JSON.stringify(c, null, 1));
  const hidden = Object.entries(c).filter(([, v]) => v.hidden);
  console.log(`books ${Object.keys(c).length}; hidden (superseded) ${hidden.length}`);
  for (const g of [...new Set(hidden.map(([, v]) => v.grade))].sort((a, b) => a - b)) {
    console.log(`G${g}:`, hidden.filter(([, v]) => v.grade === g).map(([k, v]) => `${k}(${v.subject})`).join(', '));
  }
}).catch((e) => { console.error(e); process.exit(1); });
