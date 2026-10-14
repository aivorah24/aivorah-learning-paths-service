// Source registry: data/cisce/source-registry.json is the committed copy;
// discover/download update it in place so verified metadata can be committed.
const fs = require('fs');
const path = require('path');

const DEFAULT_REGISTRY_PATH = path.join(__dirname, '..', '..', 'data', 'cisce', 'source-registry.json');

// Every field a cisce_sources row carries, with defaults for seed entries.
const FIELDS = {
  id: null, url: null, kind: null, programme: null, exam_year: null, version: null, is_primary_version: false,
  subject: null, title: null, grades: [], link_status: 'UNVERIFIED', http_status: null, final_url: null,
  content_type: null, sha256: null, bytes: null, page_count: null, checked_at: null, checked_from: null,
  discovered_from: null, licence: 'CISCE_COPYRIGHT_METADATA_ONLY', storage: 'NONE', storage_public_id: null,
  storage_approved_by: null, notes: null, metadata: {},
};

const withDefaults = (s) => ({ ...structuredClone(FIELDS), ...s });

function loadRegistry(file = DEFAULT_REGISTRY_PATH) {
  const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
  return { ...raw, sources: (raw.sources || []).map(withDefaults), awaiting_sources: raw.awaiting_sources || [] };
}

function saveRegistry(registry, file = DEFAULT_REGISTRY_PATH) {
  const sources = [...registry.sources].sort((a, b) => a.id.localeCompare(b.id));
  fs.writeFileSync(file, `${JSON.stringify({ ...registry, sources }, null, 2)}\n`);
}

// Adds a discovered source unless its URL is already known (a dead seed URL
// stays dead; a known live one keeps its id and checked metadata).
function upsertSource(registry, source) {
  const existing = registry.sources.find((s) => s.url === source.url || s.id === source.id);
  if (existing) {
    for (const [k, v] of Object.entries(source)) if (existing[k] == null && v != null) existing[k] = v;
    return existing;
  }
  const s = withDefaults(source);
  registry.sources.push(s);
  return s;
}

function summarise(registry) {
  const byStatus = {};
  for (const s of registry.sources) byStatus[s.link_status] = (byStatus[s.link_status] || 0) + 1;
  const byKind = {};
  for (const s of registry.sources) byKind[s.kind] = (byKind[s.kind] || 0) + 1;
  return { total: registry.sources.length, byStatus, byKind, awaiting: registry.awaiting_sources.length };
}

const isPdfKind = (kind) => /_PDF$|_CIRCULAR$/.test(kind || '');

module.exports = { DEFAULT_REGISTRY_PATH, FIELDS, loadRegistry, saveRegistry, upsertSource, summarise, isPdfKind, withDefaults };
