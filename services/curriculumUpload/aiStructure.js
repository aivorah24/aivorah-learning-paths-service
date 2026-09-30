const { callWithFallback } = require('../llm/fallback');

// Finds a curriculum's units -> topics -> subtopics (+ the teacher's notes per topic) in ANY uploaded document —
// tables, headings, numbered lists, one sheet or many — with one AI call per part of the document. Everything
// returned is checked against the document's own text; anything not found there is dropped, never invented.

const CHUNK_CHARS = 8000;
const MAX_FOLLOW_UPS = 3;
const UNIT_PREFIX_RE = /^(?:unit|chapter|module|strand|theme|topic)\s*([0-9]+|[ivxlcdm]+)?\s*[:.\-–—]\s*/i;

function documentText(extracted) {
  if (extracted.format === 'xlsx') {
    return extracted.sheets.map((sheet) => [
      `Sheet: ${sheet.name}`,
      ...sheet.rows.map((row) => row.map((c) => String(c ?? '').trim()).join('\t')),
    ].join('\n')).join('\n\n');
  }
  return extracted.text || '';
}

// Splits on line boundaries so a table row or heading is never cut in half.
function chunks(text) {
  const out = [];
  let current = '';
  for (const line of text.split('\n')) {
    if (current.length + line.length > CHUNK_CHARS && current) { out.push(current); current = ''; }
    current += `${line}\n`;
  }
  if (current.trim()) out.push(current);
  return out;
}

function buildPrompt(part, index, total) {
  return `You are reading a school curriculum document that a teacher uploaded${total > 1 ? ` (part ${index + 1} of ${total})` : ''}. Its layout can be anything: tables (cells separated by tabs), headings, numbered or bulleted lists, spreadsheet rows.

Find its structure: units (a unit may be called Unit, Chapter, Module, Strand, Theme, Criterion...), the topics in each unit, the subtopics of each topic, and the teacher's notes for each topic (learning objectives, key concepts, skills, activities, assessment ideas).

Rules:
- Use ONLY what is in the document. Copy titles as written, without numbering prefixes like "Unit 1:" or "1.2".
- Subtopics listed together in one cell or line (separated by ; or commas in a list) are separate subtopics.
- Notes: at most 3 per topic, each a short phrase (under 20 words) copied from the document and starting with its label (e.g. "Learning objectives: ..."). Keep them short so you can cover EVERY topic.
- Cover every unit and topic in the text below, to the very end.
- Ignore anything that is not something students learn: cover text, purposes, disclaimers, page furniture, and sections about how the document is to be used or processed (instructions, notes to the reader, generation/mapping logic, appendices).
- If topics have no unit, use one unit with "title": null.
- Also report grade, subject and curriculum if the document states them, else null.

DOCUMENT:
"""
${part}
"""

Respond with ONLY JSON:
{"metadata":{"grade":null,"subject":null,"curriculum":null},"units":[{"title":"...","topics":[{"title":"...","subtopics":["..."],"notes":["..."]}]}]}`;
}

const words = (s) => String(s || '').toLowerCase().normalize('NFKD').replace(/[^\p{L}\p{N}]+/gu, ' ').trim().split(/\s+/).filter(Boolean);

// True when the text is really in the document: as a phrase, or (for reworded/merged cells) most of its words.
function makeFoundIn(sourceText) {
  const sourceWords = words(sourceText);
  const flat = ` ${sourceWords.join(' ')} `;
  const vocab = new Set(sourceWords);
  return (text, minShare = 0.8) => {
    const w = words(text);
    if (!w.length) return false;
    if (flat.includes(` ${w.join(' ')} `)) return true;
    return w.filter((x) => vocab.has(x)).length / w.length >= minShare;
  };
}

const clean = (s) => String(s ?? '').trim().replace(UNIT_PREFIX_RE, '').trim();

// Some models wrap the answer in a list: [{ metadata, units }] or even a bare list of units.
function unwrap(parsed) {
  if (!Array.isArray(parsed)) return parsed;
  return parsed.find((x) => x && Array.isArray(x.units)) || { units: parsed.filter((x) => x && Array.isArray(x.topics)) };
}

function verify(parsed, foundIn) {
  const units = [];
  for (const u of Array.isArray(parsed?.units) ? parsed.units : []) {
    const title = u?.title ? clean(u.title) : null;
    const topics = (Array.isArray(u?.topics) ? u.topics : [])
      .map((t) => ({
        title: clean(t?.title),
        subtopics: (Array.isArray(t?.subtopics) ? t.subtopics : []).map(clean).filter((s) => s && foundIn(s)),
        notes: (Array.isArray(t?.notes) ? t.notes : []).map((n) => String(n ?? '').trim()).filter((n) => n && foundIn(n, 0.6)),
      }))
      .filter((t) => t.title && foundIn(t.title));
    if (!topics.length) continue;
    units.push({ title: title && foundIn(title) ? title : null, topics });
  }
  const md = parsed?.metadata || {};
  const keep = (v) => (v && foundIn(String(v), 0.5) ? String(v).trim() : undefined);
  return { units, metadata: { grade: keep(md.grade), subject: keep(md.subject), curriculum: keep(md.curriculum) } };
}

// Index of the last document line the answer accounts for (a topic, subtopic or note found in it).
function lastCoveredLine(lines, result) {
  const pieces = result.units.flatMap((u) => [u.title, ...u.topics.flatMap((t) => [t.title, ...t.subtopics, ...t.notes])]).filter(Boolean);
  let last = -1;
  lines.forEach((line, i) => {
    const lw = new Set(words(line));
    if (!lw.size) return;
    if (pieces.some((p) => {
      const pw = words(p.replace(/^[^:]{1,40}:\s*/, ''));
      return pw.length && pw.filter((w) => lw.has(w)).length / pw.length >= 0.8;
    })) last = i;
  });
  return last;
}

// Real content left after the covered part (a line with a few words, e.g. one last table row).
function leftover(lines, from) {
  const rest = lines.slice(from + 1).filter((l) => words(l).length >= 3);
  return rest.length >= 1 ? rest : null;
}

// Units with the same title across parts (a long document) are joined; topics keep document order.
function merge(results) {
  const units = [];
  const metadata = {};
  for (const r of results) {
    for (const [k, v] of Object.entries(r.metadata)) if (v && !metadata[k]) metadata[k] = v;
    for (const u of r.units) {
      const last = units[units.length - 1];
      if (last && (last.title || '').toLowerCase() === (u.title || '').toLowerCase()) last.topics.push(...u.topics);
      else units.push({ title: u.title, topics: [...u.topics] });
    }
  }
  return { units, metadata };
}

// Normalized curriculum (same shape as normalization.js produces) or null when the AI found nothing usable.
async function structureWithAI(extracted) {
  const text = documentText(extracted);
  if (!text.trim()) return null;
  const foundIn = makeFoundIn(text);
  const parts = chunks(text);
  const results = [];
  for (let i = 0; i < parts.length; i += 1) {
    let text = parts[i];
    // A model can stop early with a valid but incomplete answer: ask again for whatever is left, a few times.
    for (let round = 0; round <= MAX_FOLLOW_UPS && text; round += 1) {
      let result;
      try {
        result = verify(unwrap(JSON.parse(await callWithFallback(buildPrompt(text, i, parts.length), { json: true, temperature: 0 }))), foundIn);
      } catch (err) {
        console.error(`[aiStructure] part ${i + 1}/${parts.length} failed:`, err.message);
        break;
      }
      results.push(result);
      const lines = text.split('\n');
      const rest = leftover(lines, lastCoveredLine(lines, result));
      if (!rest || !result.units.length) break;
      const lastUnit = result.units[result.units.length - 1].title;
      text = `${lastUnit ? `(continuing unit: ${lastUnit})\n` : ''}${rest.join('\n')}`;
    }
  }
  const { units, metadata } = merge(results);
  if (!units.some((u) => u.topics.length)) return null;
  return {
    sourceFormat: extracted.format,
    unstructured: false,
    preambleText: '',
    metadata: Object.fromEntries(Object.entries(metadata).filter(([, v]) => v)),
    structuredBy: 'ai',
    units: units.map((u, ui) => ({
      title: u.title,
      order: ui,
      content: [],
      sourceRef: {},
      topics: u.topics.map((t, ti) => ({
        title: t.title,
        order: ti,
        content: t.notes,
        sourceRef: {},
        subtopics: t.subtopics.map((s, si) => ({ title: s, order: si })),
      })),
    })),
  };
}

module.exports = { structureWithAI, documentText, chunks, makeFoundIn, verify, merge, buildPrompt, lastCoveredLine, leftover, unwrap };
