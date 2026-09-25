// Re-serializes JSON using the original file's indent, line endings and trailing newline so diffs stay minimal.
function serializeLike(raw, obj) {
  const indent = /^\{\r?\n( +)"/.exec(raw)?.[1].length ?? 2;
  const eol = raw.includes('\r\n') ? '\r\n' : '\n';
  const out = JSON.stringify(obj, null, indent).replace(/\n/g, eol);
  return /\n$/.test(raw) ? out + eol : out;
}
module.exports = { serializeLike };
