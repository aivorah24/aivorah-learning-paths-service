#!/usr/bin/env node
/**
 * Copies the official CISCE tables (cisce_*) from the Dev Supabase project to
 * the Test project (which the live app uses), via the Supabase Management API.
 * Only cisce_* tables are touched; Test's copy is replaced wholesale.
 *
 *   node scripts/cisce-copy-to-test.cjs            copy
 *   node scripts/cisce-copy-to-test.cjs --dry-run  only print what would be copied
 *
 * Needs SUPABASE_ACCESS_TOKEN, DEV_REF, TEST_REF (read from ../aivorah-db/.env if unset).
 */
const fs = require('fs');
const path = require('path');

const dbEnv = path.join(__dirname, '..', '..', 'aivorah-db', '.env');
if (fs.existsSync(dbEnv)) {
  for (const line of fs.readFileSync(dbEnv, 'utf8').split(/\r?\n/)) {
    const m = line.match(/^([A-Z_]+)=(.*)$/);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2].trim();
  }
}
const { SUPABASE_ACCESS_TOKEN: TOKEN, DEV_REF, TEST_REF } = process.env;
if (!TOKEN || !DEV_REF || !TEST_REF) throw new Error('SUPABASE_ACCESS_TOKEN, DEV_REF and TEST_REF are required');
const dryRun = process.argv.includes('--dry-run');

async function sql(ref, query, attempt = 1) {
  const res = await fetch(`https://api.supabase.com/v1/projects/${ref}/database/query`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${TOKEN}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ query }),
  });
  const text = await res.text();
  if (!res.ok) {
    if (attempt < 4) { await new Promise((r) => setTimeout(r, 2000 * attempt)); return sql(ref, query, attempt + 1); }
    throw new Error(`${ref}: HTTP ${res.status} ${text.slice(0, 300)}`);
  }
  return JSON.parse(text);
}

const lit = (v) => `'${String(v).replace(/'/g, "''")}'`;
const LEVEL_ORDER = "case level when 'FRAMEWORK_SECTION' then 0 when 'UNIT' then 1 when 'TOPIC' then 2 else 3 end";

// Children before parents for delete, parents before children for insert.
const TABLES = [
  { name: 'cisce_sources', order: 'id' },
  { name: 'cisce_extractions', order: 'source_id, sha256' },
  { name: 'cisce_ingestion_runs', order: 'run_id' },
  { name: 'cisce_coverage', order: 'run_id, grade_label, subject' },
  { name: 'cisce_curriculum_nodes', order: `${LEVEL_ORDER}, id` },
];
const CHUNK = 400;

async function readAll(table) {
  const rows = [];
  for (let off = 0; ; off += 1000) {
    const page = await sql(DEV_REF, `select * from public.${table.name} order by ${table.order} limit 1000 offset ${off}`);
    rows.push(...page);
    if (page.length < 1000) return rows;
  }
}

(async () => {
  const data = {};
  for (const t of TABLES) {
    data[t.name] = await readAll(t);
    console.log(`dev ${t.name}: ${data[t.name].length} rows`);
  }
  if (dryRun) return console.log('dry run — nothing written to Test');

  // Nodes reference sources; coverage references runs — clear in reverse dependency order.
  await sql(TEST_REF, 'delete from public.cisce_curriculum_nodes; delete from public.cisce_coverage; delete from public.cisce_ingestion_runs; delete from public.cisce_extractions; delete from public.cisce_sources;');
  for (const t of TABLES) {
    const rows = data[t.name];
    for (let i = 0; i < rows.length; i += CHUNK) {
      const json = JSON.stringify(rows.slice(i, i + CHUNK));
      await sql(TEST_REF, `insert into public.${t.name} select * from json_populate_recordset(null::public.${t.name}, ${lit(json)}::json) on conflict do nothing`);
    }
    const [{ n }] = await sql(TEST_REF, `select count(*)::int n from public.${t.name}`);
    console.log(`test ${t.name}: ${n} rows${n === rows.length ? '' : `  ← MISMATCH (dev ${rows.length})`}`);
  }
  const summary = await sql(TEST_REF, `select version, grade_label, count(distinct subject) subjects, count(*) filter (where level='UNIT') chapters, count(*) filter (where level='TOPIC') topics from public.cisce_curriculum_nodes where programme in ('ICSE','ISC') group by 1,2 order by 1,2`);
  console.table(summary);
})().catch((e) => { console.error('FAILED:', e.message); process.exit(1); });
