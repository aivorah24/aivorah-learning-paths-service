// Persist stage: idempotent upserts into the cisce_* tables (aivorah-db
// migration 0017). Only cisce_* tables are ever written; syllabus_chapters,
// syllabus_topics and topic_resources are never touched.
const { CURRICULUM_ID } = require('./constants');
const { FIELDS } = require('./registry');

const TABLES = { sources: 'cisce_sources', extractions: 'cisce_extractions', nodes: 'cisce_curriculum_nodes', runs: 'cisce_ingestion_runs', coverage: 'cisce_coverage' };
const WRITABLE = new Set(Object.values(TABLES));
const BATCH = 500;

const sourceRow = (s) => {
  const row = {};
  for (const k of Object.keys(FIELDS)) row[k] = s[k] ?? FIELDS[k];
  // A YYYY-MM-DD owner check date is a valid timestamptz; keep it.
  row.updated_at = new Date().toISOString();
  return row;
};

function nodeRows(doc) {
  const rows = [];
  for (const g of doc.grades) {
    // Parents first so the self-referencing foreign key is satisfied within a batch.
    const ordered = [...g.nodes].sort((a, b) => (a.parent_id ? 1 : 0) - (b.parent_id ? 1 : 0));
    for (const n of ordered) {
      rows.push({
        id: n.id,
        curriculum_id: CURRICULUM_ID,
        version: doc.version,
        exam_year: doc.exam_year,
        programme: doc.programme,
        source_id: doc.source.source_id,
        source_sha256: doc.source.sha256,
        grade_label: g.grade_label,
        grade_number: g.grade_number,
        subject: doc.subject,
        level: n.level,
        parent_id: n.parent_id,
        ordinal: n.ordinal,
        number_label: n.number_label,
        path: n.path,
        title: n.title,
        body: n.body,
        page_from: n.page_from,
        page_to: n.page_to,
        provenance_status: doc.provenance_status,
        approved: false,
        content_hash: n.content_hash,
        updated_at: new Date().toISOString(),
      });
    }
  }
  return rows;
}

const extractionRow = (doc) => ({
  source_id: doc.source.source_id,
  sha256: doc.source.sha256,
  page_count: doc.extraction.page_count,
  text_pages: doc.extraction.text_pages,
  ocr_pages: doc.extraction.ocr_pages,
  empty_pages: doc.extraction.empty_pages,
  warnings: doc.warnings,
});

function createWriter(db, { dryRun = false, log = () => {} } = {}) {
  const planned = [];
  const table = (name) => {
    if (!WRITABLE.has(name)) throw new Error(`refusing to write to ${name}: only cisce_* tables are writable`);
    return db.from(name);
  };
  async function upsert(name, rows, onConflict) {
    planned.push({ op: 'upsert', table: name, rows: rows.length });
    if (dryRun || !rows.length) return;
    for (let i = 0; i < rows.length; i += BATCH) {
      const { error } = await table(name).upsert(rows.slice(i, i + BATCH), { onConflict });
      if (error) throw new Error(`${name} upsert failed: ${error.message}`);
    }
    log(`persist ${name}: ${rows.length} row(s)`);
  }
  // Nodes from an older copy of the same source+version (different sha256)
  // are replaced by the new extraction; nothing outside cisce_* is involved.
  async function deleteStaleNodes(doc) {
    planned.push({ op: 'delete-stale', table: TABLES.nodes, source_id: doc.source.source_id, version: doc.version });
    if (dryRun) return;
    const { error } = await table(TABLES.nodes).delete()
      .eq('source_id', doc.source.source_id).eq('version', doc.version).neq('source_sha256', doc.source.sha256);
    if (error) throw new Error(`${TABLES.nodes} stale delete failed: ${error.message}`);
  }
  // Same file, re-normalised: nodes the new rules no longer produce (e.g. a
  // misread practical-work list) are removed; kept ids keep their approval.
  async function deleteDroppedNodes(doc, keepIds) {
    planned.push({ op: 'delete-dropped', table: TABLES.nodes, source_id: doc.source.source_id, version: doc.version });
    if (dryRun || !keepIds.length) return;
    const { error } = await table(TABLES.nodes).delete()
      .eq('source_id', doc.source.source_id).eq('version', doc.version).not('id', 'in', `(${keepIds.join(',')})`);
    if (error) throw new Error(`${TABLES.nodes} dropped-node delete failed: ${error.message}`);
  }
  return {
    planned,
    persistSources: (sources) => upsert(TABLES.sources, sources.map(sourceRow), 'id'),
    async persistDocument(doc) {
      await upsert(TABLES.extractions, [extractionRow(doc)], 'source_id,sha256');
      await deleteStaleNodes(doc);
      const rows = nodeRows(doc);
      await upsert(TABLES.nodes, rows, 'id');
      await deleteDroppedNodes(doc, rows.map((r) => r.id));
    },
    persistRun: (run) => upsert(TABLES.runs, [run], 'run_id'),
    persistCoverage: (runId, rows) => upsert(TABLES.coverage, rows.map((r) => ({
      run_id: runId, grade_label: r.grade_label, subject: r.subject, status: r.status, source_ids: r.source_ids,
      unit_count: r.unit_count, topic_count: r.topic_count, notes: r.notes,
    })), 'run_id,grade_label,subject'),
  };
}

module.exports = { createWriter, nodeRows, sourceRow, extractionRow, TABLES };
