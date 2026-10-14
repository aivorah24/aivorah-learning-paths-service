// Write guard: persist/index refuse to run unless the target is the Dev
// Supabase project. Test/Prod refs are refused even if explicitly expected.
const { DEV_SUPABASE_REF, REFUSED_SUPABASE_REFS } = require('./constants');

function supabaseRef(url) {
  const m = String(url || '').replace(/\s+/g, '').match(/^https:\/\/([a-z0-9]{20})\.supabase\.co\/?$/i);
  return m ? m[1].toLowerCase() : null;
}

function assertDevTarget(env = process.env) {
  const ref = supabaseRef(env.SUPABASE_URL);
  if (!ref) throw new Error('SUPABASE_URL is not a https://<ref>.supabase.co URL — refusing to write.');
  if (REFUSED_SUPABASE_REFS.includes(ref)) throw new Error(`SUPABASE_URL points at ${ref}, which is not Dev — refusing to write.`);
  const expected = (env.CISCE_EXPECTED_SUPABASE_REF || DEV_SUPABASE_REF).toLowerCase();
  if (REFUSED_SUPABASE_REFS.includes(expected)) throw new Error(`CISCE_EXPECTED_SUPABASE_REF=${expected} is a refused (Test/Prod) project.`);
  if (ref !== expected) throw new Error(`SUPABASE_URL points at ${ref}; this pipeline only writes to ${expected} (Dev).`);
  return ref;
}

module.exports = { assertDevTarget, supabaseRef };
