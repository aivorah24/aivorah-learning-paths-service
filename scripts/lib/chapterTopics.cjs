// Helpers for generating grounded topic lists from a chapter's own text: sectioning, prompt, validation, merge.

const norm = (s) => String(s || '').toLowerCase().replace(/[’‘`´]/g, "'").replace(/[^\p{L}\p{N}']+/gu, ' ').trim();

function splitSections(text, maxChars = 10000) {
  const paras = String(text || '').replace(/\r/g, '').split(/\n\s*\n/).map((p) => p.trim()).filter(Boolean);
  const out = [];
  let cur = '';
  for (const p of paras) {
    if (cur && cur.length + p.length + 2 > maxChars) { out.push(cur); cur = ''; }
    if (p.length > maxChars) {
      for (let i = 0; i < p.length; i += maxChars) out.push(p.slice(i, i + maxChars));
      continue;
    }
    cur += (cur ? '\n\n' : '') + p;
  }
  if (cur) out.push(cur);
  return out.filter((s) => s.replace(/\s+/g, '').length > 300);
}

function buildPrompt({ grade, subject, book, title, script, text }) {
  const language = script === 'Devanagari'
    ? 'Write name, key_terms and explanation in Hindi (Devanagari script), matching the textbook.'
    : 'Write in simple English.';
  return `You are building a study guide for NCERT Class ${grade} ${subject}${book ? ` (textbook: ${book})` : ''}, chapter "${title}".
Use ONLY the textbook excerpt below. Do not add facts that are not in it.

List the distinct teachable topics this excerpt covers (0 to 12). For each topic give:
- "name": 2-6 words, taken from the excerpt's own headings or terms
- "key_terms": 2-4 words or phrases copied from the excerpt
- "explanation": 2-4 simple sentences for a Class ${grade} student, using only facts stated in the excerpt
- "quote": an exact phrase of 6-20 words copied verbatim from the excerpt that supports the explanation

If the excerpt is only exercises, credits, page furniture or activity instructions with no teachable content, return {"topics": []}.
${language}
Return only JSON: {"topics":[{"name":"","key_terms":[],"explanation":"","quote":""}]}

TEXTBOOK EXCERPT:
"""
${text}
"""`;
}

function parseJson(raw) {
  const s = String(raw || '').trim().replace(/^```(?:json)?/i, '').replace(/```$/, '').trim();
  try { return JSON.parse(s); } catch { /* try to find the outermost object */ }
  const a = s.indexOf('{');
  const b = s.lastIndexOf('}');
  if (a >= 0 && b > a) { try { return JSON.parse(s.slice(a, b + 1)); } catch { return null; } }
  return null;
}

function quoteInText(quote, normText) {
  const q = norm(quote);
  if (!q) return false;
  if (normText.includes(q)) return true;
  const qt = q.split(' ');
  if (qt.length < 5) return false;
  const tt = normText.split(' ');
  const need = Math.ceil(qt.length * 0.85);
  const qset = new Set(qt);
  for (let i = 0; i + qt.length <= tt.length; i += 1) {
    let hit = 0;
    for (let j = 0; j < qt.length; j += 1) if (qset.has(tt[i + j])) hit += 1;
    if (hit >= need) return true;
  }
  return false;
}

// Returns { ok, reason } — a topic is kept only if it is grounded in the section text.
function validateTopic(t, sectionText) {
  if (!t || typeof t !== 'object') return { ok: false, reason: 'not-object' };
  const name = String(t.name || '').trim();
  const explanation = String(t.explanation || '').trim();
  const terms = Array.isArray(t.key_terms) ? t.key_terms.map((x) => String(x).trim()).filter(Boolean) : [];
  if (name.length < 3 || name.length > 70 || /^chapter\s*\d+$/i.test(name)) return { ok: false, reason: 'bad-name' };
  if (explanation.length < 40 || explanation.length > 700) return { ok: false, reason: 'bad-explanation-length' };
  if (terms.length < 1 || terms.length > 6) return { ok: false, reason: 'bad-key-terms' };
  const normText = norm(sectionText);
  if (!terms.some((k) => normText.includes(norm(k)))) return { ok: false, reason: 'key-terms-not-in-text' };
  if (!quoteInText(t.quote, normText)) return { ok: false, reason: 'quote-not-in-text' };
  return { ok: true };
}

function mergeTopics(lists, cap = 30) {
  const seen = new Set();
  const out = [];
  for (const list of lists) {
    for (const t of list) {
      const k = norm(t.name);
      if (!k || seen.has(k)) continue;
      seen.add(k);
      out.push({ name: t.name.trim(), key_terms: t.key_terms.map((x) => String(x).trim()), explanation: t.explanation.trim(), quote: String(t.quote).trim() });
      if (out.length >= cap) return out;
    }
  }
  return out;
}

module.exports = { norm, splitSections, buildPrompt, parseJson, validateTopic, mergeTopics, quoteInText };
