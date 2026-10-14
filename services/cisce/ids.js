// Deterministic ids: the same input always yields the same id, so every
// upsert (Supabase rows, Qdrant points) lands on the row a previous run wrote.
const crypto = require('crypto');

const sha256 = (data) => crypto.createHash('sha256').update(data).digest('hex');

// RFC 4122-shaped UUID (version 5 nibble, variant 10xx) from a sha256 of the parts.
function uuidFrom(...parts) {
  const h = sha256(parts.map((p) => String(p ?? '')).join('\u001f'));
  const v = ((parseInt(h[16], 16) & 0x3) | 0x8).toString(16);
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-5${h.slice(13, 16)}-${v}${h.slice(17, 20)}-${h.slice(20, 32)}`;
}

const slug = (s) => String(s || '').toLowerCase().normalize('NFKD').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60);

// "icse-2028-physics-3f9a1c" — readable, and unique per URL.
function sourceIdFor({ url, programme, examYear, name }) {
  return [slug(programme) || 'cisce', examYear || 'na', slug(name) || 'doc', sha256(url).slice(0, 6)].join('-');
}

module.exports = { sha256, uuidFrom, slug, sourceIdFor };
