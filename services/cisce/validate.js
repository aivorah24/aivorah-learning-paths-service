// Validate stage: a canonical document must pass every check before it can be persisted or indexed.
const { CURRICULUM_ID, GRADE_LABELS, PROVENANCE } = require('./constants');

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const LEVELS = ['UNIT', 'TOPIC', 'SUBTOPIC', 'FRAMEWORK_SECTION'];

function validateCanonical(doc) {
  const errors = [];
  const req = (cond, msg) => { if (!cond) errors.push(msg); };

  req(doc && doc.schema_version === 1, 'schema_version must be 1');
  req(doc.curriculum_id === CURRICULUM_ID, `curriculum_id must be "${CURRICULUM_ID}"`);
  req(doc.content_origin === 'official_cisce', 'content_origin must be official_cisce');
  req(doc.approved === false, 'approved must be false — approval is a separate, human step');
  req(typeof doc.version === 'string' && doc.version.length > 0, 'version is required');
  req(typeof doc.subject === 'string' && doc.subject.length > 0, 'subject is required');
  req(Object.values(PROVENANCE).includes(doc.provenance_status), 'provenance_status must be VERIFIED_OFFICIAL or OFFICIAL_PARTIAL');
  req(doc.source && doc.source.source_id && doc.source.url, 'source.source_id and source.url are required');
  req(doc.source && /^[0-9a-f]{64}$/.test(doc.source.sha256 || ''), 'source.sha256 must be a sha256 hex digest');
  req(doc.source && doc.source.page_count > 0, 'source.page_count must be > 0');
  req(Array.isArray(doc.grades), 'grades must be an array');

  const ids = new Set();
  for (const g of doc.grades || []) {
    req(GRADE_LABELS.includes(g.grade_label), `unknown grade_label "${g.grade_label}"`);
    const unitPaths = new Set();
    const byId = new Map((g.nodes || []).map((n) => [n.id, n]));
    for (const n of g.nodes || []) {
      const where = `${g.grade_label} ${n.path}`;
      req(UUID.test(n.id || ''), `${where}: id must be a uuid`);
      req(!ids.has(n.id), `${where}: duplicate id ${n.id}`);
      ids.add(n.id);
      req(LEVELS.includes(n.level), `${where}: bad level ${n.level}`);
      req(typeof n.title === 'string' && n.title.trim().length > 0, `${where}: empty title`);
      req(Number.isInteger(n.page_from) && n.page_from >= 1 && n.page_from <= (doc.source?.page_count || 0), `${where}: page_from out of range`);
      req(Number.isInteger(n.page_to) && n.page_to >= n.page_from && n.page_to <= (doc.source?.page_count || 0), `${where}: page_to out of range`);
      req(/^[0-9a-f]{64}$/.test(n.content_hash || ''), `${where}: content_hash missing`);
      if (n.level === 'UNIT') {
        req(!unitPaths.has(n.path), `${where}: duplicate unit path`);
        unitPaths.add(n.path);
      }
      if (n.level === 'TOPIC') req(byId.get(n.parent_id)?.level === 'UNIT', `${where}: topic parent must be a unit of the same grade`);
    }
  }
  if (doc.provenance_status === PROVENANCE.VERIFIED_OFFICIAL) {
    req(doc.source?.link_status === 'VERIFIED', 'VERIFIED_OFFICIAL needs a VERIFIED source');
    req((doc.extraction?.empty_pages || 0) === 0, 'VERIFIED_OFFICIAL needs every page read');
    req((doc.grades || []).length > 0, 'VERIFIED_OFFICIAL needs at least one grade');
  }
  return { valid: errors.length === 0, errors };
}

module.exports = { validateCanonical };
