// Parses chapter number -> title from the text of an NCERT textbook prelims PDF ("<code>ps.pdf").
const LEAD = /^(?:chapter|unit|lesson)?\s*\d{1,2}\s*[.:)\-–—]?\s*[A-Za-z]/i;
const ENTRY = /^(?:chapter|unit|lesson)?\s*(\d{1,2})\s*[.:)\-–—]?\s*(?!\d)(.*?)\s*(\d{1,3})$/i;

function clean(t) {
  return t
    .replace(/\s+/g, ' ')
    .replace(/[.·…_•]{2,}/g, ' ')
    .replace(/^[\s.:\-–—]+|[\s.:\-–—]+$/g, '')
    .replace(/\b(\w+)\s+\1\b/gi, '$1')
    .trim();
}

function entries(text) {
  const lines = text.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  const out = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (/^\d{1,2}\.\d/.test(line)) continue;
    let m = ENTRY.exec(line);
    if (!m && LEAD.test(line) && i + 1 < lines.length) {
      const next = lines[i + 1];
      if (!LEAD.test(next) && /\d{1,3}$/.test(next)) m = ENTRY.exec(`${line} ${next}`);
    }
    if (!m) continue;
    const title = clean(m[2]);
    if (!/[A-Za-z]{3}/.test(title)) continue;
    out.push({ pos: i, n: Number(m[1]), title, page: Number(m[3]) });
  }
  return out;
}

const SMALL = new Set(['a', 'an', 'and', 'as', 'at', 'by', 'for', 'in', 'of', 'on', 'or', 'the', 'to', 'with']);

function titleCase(t) {
  const cut = t.replace(/(?<=[A-Za-z]{2})\s+\d{1,3}(?:\.\d+)?\s.*\s\d{1,3}$/, '').trim();
  const words = cut.split(' ');
  const upper = words.filter((w) => /^[^a-z]*[A-Z]{2,}[^a-z]*$/.test(w)).length;
  const noisy = words.some((w) => /[a-z][A-Z]|[A-Z]{2,}[a-z]/.test(w));
  if (!noisy && upper < words.length / 2) return cut;
  return cut.toLowerCase().split(' ').map((w, i) => (i > 0 && SMALL.has(w) ? w : w.replace(/^([("'‘“]*)([a-z])/, (_, x, y) => x + y.toUpperCase()))).join(' ');
}

const HEAD = /^(?:chapter|unit|lesson|theme)\s+(\d{1,2})\s*[.:]?\s*(.*)$/i;

// "CHAPTER 3" / title lines / "3.1 First section" layout with no page numbers.
function headingEntries(text) {
  const lines = text.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  const out = [];
  for (let i = 0; i < lines.length; i++) {
    const m = HEAD.exec(lines[i]);
    if (!m) continue;
    const parts = m[2] ? [m[2]] : [];
    for (let k = i + 1; k < lines.length && parts.length < 3; k++) {
      const l = lines[k];
      if (/^\d{1,2}\.\d/.test(l) || HEAD.test(l) || /^\d{1,3}$/.test(l) || /^(?:chapter|unit|theme|part)/i.test(l)) break;
      parts.push(l);
    }
    const title = clean(parts.join(' ')).replace(/(?<=[A-Za-z?)!])\s+\d{1,3}$/, '');
    if (/[A-Za-z]{3}/.test(title)) out.push({ pos: i, n: Number(m[1]), title, page: null });
  }
  return out;
}


const FRONT = /^(?:contents?|foreword|preface|acknowledg\w*|a note (?:for|to) the teachers?|note to the teachers?|rationali[sz]ation.*|answers?(?:\s*\/\s*hints)?|appendix.*|index|glossary|विषय[- ]सूची|अनुक्रमणिका|अनुक्रम|आमुख|प्रस्तावना|उत्तरमाला|पाठ्यपुस्तकों में.*|भूमिका)$/i;
const NOISE = /^[\dIlivxVX|()\[\].,:;\-–—\s]*$/;

// Column layout: titles listed in one block, page numbers elsewhere. Accepted only when the block has exactly `count` lines.
function blockList(text, count) {
  const lines = text.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  let best = null;
  for (let i = 0; i < lines.length; i++) {
    if (!FRONT.test(lines[i])) continue;
    const block = [];
    for (let k = i + 1; k < lines.length; k++) {
      const l = lines[k];
      if (NOISE.test(l) || /^reprint\b/i.test(l)) break;
      if (FRONT.test(l)) { if (block.length === 0) continue; break; }
      if (/^(?:chapter|unit|theme|अध्याय|पाठ)\b/i.test(l)) continue;
      block.push(clean(l));
    }
    if (block.length === count) best = block;
  }
  const byNumber = {};
  if (best) best.forEach((t, idx) => { byNumber[idx + 1] = titleCase(t); });
  return byNumber;
}

function longestRun(cands, first) {
  let best = [];
  for (let s = 0; s < cands.length; s++) {
    if (cands[s].n !== first) continue;
    const run = [cands[s]];
    for (let k = s + 1; k < cands.length; k++) {
      const last = run[run.length - 1];
      if (cands[k].n === last.n + 1 && (cands[k].page == null || last.page == null || cands[k].page >= last.page)) run.push(cands[k]);
    }
    if (run.length >= best.length) best = run;
  }
  return best;
}

function parseToc(text, firstChapter = 1) {
  const byNumber = {};
  const a = longestRun(entries(text), firstChapter);
  const b = longestRun(headingEntries(text), firstChapter);
  for (const e of b.length > a.length ? b : a) byNumber[e.n] = titleCase(e.title);
  return byNumber;
}

module.exports = { blockList, parseToc, entries, headingEntries, clean, titleCase };
