// Gemini sometimes leaves a quotation mark inside a string unescaped ("the king said "wait" and left"), which breaks
// JSON.parse. A quote inside a string counts as closing it only when the next non-space character could follow a
// string value (, } ] :); any other inner quote is escaped. Also drops trailing commas.
function repairJson(text) {
  const s = String(text).trim().replace(/^```(?:json)?\s*|\s*```$/g, '');
  let out = '';
  let inString = false;
  for (let i = 0; i < s.length; i += 1) {
    const ch = s[i];
    if (inString) {
      if (ch === '\\') { out += ch + (s[i + 1] ?? ''); i += 1; continue; }
      if (ch === '\n') { out += '\\n'; continue; }
      if (ch === '"') {
        let j = i + 1;
        while (j < s.length && /\s/.test(s[j])) j += 1;
        if (j >= s.length || ',}]:'.includes(s[j])) { inString = false; out += ch; } else out += '\\"';
        continue;
      }
      out += ch;
    } else {
      if (ch === '"') inString = true;
      out += ch;
    }
  }
  return out.replace(/,(\s*[}\]])/g, '$1');
}

function parseJsonLoose(text) {
  try { return JSON.parse(text); } catch { return JSON.parse(repairJson(text)); }
}

module.exports = { repairJson, parseJsonLoose };
