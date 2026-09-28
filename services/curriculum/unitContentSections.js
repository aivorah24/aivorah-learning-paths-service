const supabase = require('../supabase');

// Section content built ahead of time for every non-Maths unit (scripts/build-unit-content.cjs): Learn blocks, a Listen
// script with a visual per scene, and a Practice quiz, one row per printed section in `unit_content_sections`.
// A topic opened by name gets the section whose words match it best.
const CACHE_MS = 10 * 60 * 1000;
const cache = new Map(); // pdfFile -> { at, rows }

const STOP = new Set('the and of a an to in on for with by is are what how its it this that from'.split(' '));
const words = (s) => String(s || '').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').split(' ').filter((w) => w.length > 2 && !STOP.has(w));

async function sectionsFor(pdfFile) {
  const hit = cache.get(pdfFile);
  if (hit && Date.now() - hit.at < CACHE_MS) return hit.rows;
  const { data, error } = await supabase.from('unit_content_sections')
    .select('section_no, section_title, page_from, lang, learn, listen, quiz').eq('pdf_file', pdfFile).order('section_no');
  const rows = error ? [] : data || [];
  cache.set(pdfFile, { at: Date.now(), rows });
  return rows;
}

function score(topic, row) {
  const t = words(topic);
  if (!t.length) return 0;
  const title = new Set(words(row.section_title));
  const learn = row.learn || {};
  const hay = new Set(words([row.section_title, ...(learn.whatYoullLearn || []), ...(row.listen || []).map((s) => s.heading),
    ...(learn.blocks || []).map((b) => b.text || b.title || '')].join(' ')));
  return t.reduce((acc, w) => acc + (title.has(w) ? 2 : hay.has(w) ? 1 : 0), 0) / t.length;
}

// Best-matching section content for a topic in the unit `pdfFile`, or null when the unit has none yet.
async function unitContentForTopic(pdfFile, topic) {
  if (!pdfFile) return null;
  const rows = await sectionsFor(pdfFile);
  if (!rows.length) return null;
  const best = rows.map((r) => ({ r, s: score(topic, r) })).sort((a, b) => b.s - a.s)[0];
  const row = best.s > 0 ? best.r : rows[0];
  return { section: row.section_title, pdfPage: row.page_from, lang: row.lang, learn: row.learn, listen: row.listen || [], quiz: row.quiz || [] };
}

// Learn text with visuals placed between it: the book's own pictures and the section's Listen diagrams, one after
// the overview and then one after every two text blocks (at most 4), so pictures support the text, not replace it.
function learnWithVisuals(learn, listen) {
  const blocks = Array.isArray(learn?.blocks) ? learn.blocks : [];
  const has = (b) => ['image', 'visual', 'visual_representation'].includes(b.type);
  const visuals = [];
  for (const sc of Array.isArray(listen) ? listen : []) {
    const v = sc && sc.visual;
    if (!v || !v.kind) continue;
    if (v.kind === 'image' && v.url) visuals.push({ type: 'image', url: v.url, caption: v.caption || v.title || '' });
    else if (v.kind !== 'image') visuals.push({ type: 'visual', visual: v });
  }
  const pool = [...visuals.filter((v) => v.type === 'image'), ...visuals.filter((v) => v.type === 'visual')]
    .slice(0, Math.max(0, 4 - blocks.filter(has).length));
  if (!pool.length) return learn;
  const out = [];
  let text = 0;
  for (const b of blocks) {
    out.push(b);
    if (has(b)) continue;
    text += 1;
    if (pool.length && (text === 1 || text % 2 === 1)) out.push(pool.shift());
  }
  out.push(...pool);
  return { ...learn, blocks: out };
}

module.exports = { unitContentForTopic, learnWithVisuals, _score: score, _cache: cache };
