// Read-only audit of NCERT chapter titles (grades 1-12): JSON seed files + syllabus_chapters.
// Usage: node scripts/audit-ncert-anomalies.cjs [--out report.json] [--no-db]
require('dotenv').config();
const fs = require('fs');
const path = require('path');

const RULES = [
  ['placeholder', (t) => /^chapter\s*\d+$/i.test(t)],
  ['front-matter', (t) => /\b(preface|foreword|note to (the )?teachers?|constitution|prelims|scripts? for stage)\b/i.test(t)],
  ['too-short', (t) => t.length < 4],
  ['too-long', (t) => t.length > 65],
  ['ocr-digits', (t) => /\d{2,}\s+\d{2,}/.test(t) || /^\d{2,}[a-z]/i.test(t)],
  ['header-token', (t) => /\bhoneydew\b|\bunits?\s*\d+/i.test(t)],
];

function anomalies(title, topicCount) {
  const t = String(title || '').trim();
  const hits = RULES.filter(([, test]) => test(t)).map(([name]) => name);
  if (topicCount === 0) hits.push('zero-topics');
  return hits;
}

function scanJson() {
  const dir = path.join(__dirname, '..', 'data', 'curricula');
  const rows = [];
  for (const f of fs.readdirSync(dir).filter((x) => x.endsWith('-chapters.json'))) {
    const j = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'));
    const g = parseInt(String(j.grade).replace(/\D/g, ''), 10);
    if (!(g >= 1 && g <= 12)) continue;
    for (const c of j.chapters || []) {
      const topics = c.subtopics || c.topics;
      const hits = anomalies(c.title, Array.isArray(topics) ? topics.length : undefined);
      if (hits.length) rows.push({ source: 'json:' + f, grade: g, subject: j.subject, chapter_number: c.chapter, title: c.title, hits });
    }
  }
  return rows;
}

async function scanDb() {
  const supabase = require('../services/supabase');
  const rows = [];
  const { data: chapters, error } = await supabase
    .from('syllabus_chapters').select('id, grade, subject, curriculum, unit_no, title').limit(20000);
  if (error) throw new Error(error.message);
  const ids = chapters.map((c) => c.id);
  const counts = {};
  for (let i = 0; i < ids.length; i += 200) {
    const { data } = await supabase.from('syllabus_topics').select('chapter_id').in('chapter_id', ids.slice(i, i + 200));
    for (const t of data || []) counts[t.chapter_id] = (counts[t.chapter_id] || 0) + 1;
  }
  for (const c of chapters) {
    const g = parseInt(String(c.grade).replace(/\D/g, ''), 10);
    if (!(g >= 1 && g <= 12)) continue;
    const hits = anomalies(c.title, counts[c.id] || 0);
    if (hits.length) rows.push({ source: `db:${c.curriculum}`, grade: g, subject: c.subject, chapter_number: c.unit_no, title: c.title, hits });
  }
  return { rows, total: chapters.length };
}

module.exports = { anomalies };

if (require.main === module) (async () => {
  const outIdx = process.argv.indexOf('--out');
  const out = outIdx > -1 ? process.argv[outIdx + 1] : null;
  const report = { json: scanJson(), db: [], dbTotal: null };
  if (!process.argv.includes('--no-db')) {
    const d = await scanDb();
    report.db = d.rows;
    report.dbTotal = d.total;
  }
  const tally = {};
  for (const r of [...report.json, ...report.db]) for (const h of r.hits) tally[`${r.source.split(':')[0]}/${h}`] = (tally[`${r.source.split(':')[0]}/${h}`] || 0) + 1;
  console.log(JSON.stringify({ jsonFlagged: report.json.length, dbFlagged: report.db.length, dbTotalRows: report.dbTotal, tally }, null, 2));
  if (out) fs.writeFileSync(out, JSON.stringify(report, null, 2));
})().catch((e) => { console.error(e.message); process.exit(1); });
