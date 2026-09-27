const supabase = require('../supabase');

// Unit-section tutors built ahead of time (scripts/build-math-units.cjs) live in `math_tutor_sections`, one row per
// printed section of a Maths unit. A topic opened by name gets the section whose words match it best.
const CACHE_MS = 10 * 60 * 1000;
const cache = new Map(); // pdfFile -> { at, rows }

const STOP = new Set('the and of a an to in on for with by is are what how find using use from its it this that'.split(' '));
const words = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').split(' ').filter((w) => w.length > 2 && !STOP.has(w));

async function sectionsFor(pdfFile) {
  const hit = cache.get(pdfFile);
  if (hit && Date.now() - hit.at < CACHE_MS) return hit.rows;
  const { data, error } = await supabase.from('math_tutor_sections')
    .select('section_no, section_title, page_from, tutor').eq('pdf_file', pdfFile).order('section_no');
  const rows = error ? [] : data || [];
  cache.set(pdfFile, { at: Date.now(), rows });
  return rows;
}

function score(topic, row) {
  const t = words(topic);
  if (!t.length) return 0;
  const hay = new Set(words([row.section_title, row.tutor?.keyIdea, ...(row.tutor?.examples || []).map((e) => `${e.title} ${e.problem}`)].join(' ')));
  const title = new Set(words(row.section_title));
  return t.reduce((acc, w) => acc + (title.has(w) ? 2 : hay.has(w) ? 1 : 0), 0) / t.length;
}

// Best-matching section tutor for a topic in the unit `pdfFile`, or null when the unit has none yet.
async function mathTutorForTopic(pdfFile, topic) {
  if (!pdfFile) return null;
  const rows = await sectionsFor(pdfFile);
  if (!rows.length) return null;
  const best = rows.map((r) => ({ r, s: score(topic, r) })).sort((a, b) => b.s - a.s)[0];
  const row = best.s > 0 ? best.r : rows[0];
  return { ...row.tutor, section: row.section_title, pdfPage: row.page_from };
}

module.exports = { mathTutorForTopic, _score: score, _cache: cache };
