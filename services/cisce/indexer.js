/**
 * Index stage: canonical nodes → Qdrant points in CISCE_COLLECTION only.
 *
 * Payload (every point):
 *   curriculum_id, board, programme, version, exam_year,
 *   grade_label, grade_number, student_grade, subject,
 *   level, node_id, parent_id, unit_id, unit_no, unit_title, topic_id, topic_title, path,
 *   text, chunk_index, chunk_count,
 *   source_id, source_url, source_sha256, page_from, page_to, extraction_method,
 *   provenance_status, approved, content_origin, content_hash,
 *   embedding_model, pipeline_version, ingested_at
 */
const {
  CISCE_COLLECTION, PROTECTED_COLLECTIONS, VECTOR_SIZE, EMBEDDING_MODEL, BOARD, PIPELINE_VERSION,
} = require('./constants');
const { uuidFrom } = require('./ids');

const CHUNK_CHARS = 1500;
const PAYLOAD_INDEXES = ['curriculum_id', 'programme', 'version', 'grade_label', 'subject', 'level', 'provenance_status', 'source_id', 'source_sha256'];

function chunk(text, size = CHUNK_CHARS) {
  const out = [];
  let rest = String(text || '').trim();
  while (rest.length > size) {
    let cut = rest.lastIndexOf('\n', size);
    if (cut < size / 2) cut = rest.lastIndexOf(' ', size);
    if (cut < size / 2) cut = size;
    out.push(rest.slice(0, cut).trim());
    rest = rest.slice(cut).trim();
  }
  if (rest) out.push(rest);
  return out.length ? out : [''];
}

function extractionMethod(doc, from, to) {
  const methods = new Set((doc.extraction?.page_methods || []).slice(from - 1, to));
  if (!methods.size) return 'text';
  return methods.size === 1 ? [...methods][0] : 'mixed';
}

/** Points (without vectors) for one canonical document. */
function buildPoints(doc, { now = () => new Date().toISOString() } = {}) {
  const points = [];
  const ingestedAt = now();
  for (const g of doc.grades) {
    const byId = new Map(g.nodes.map((n) => [n.id, n]));
    for (const n of g.nodes) {
      // A unit with topics, or an empty section holding theme units, is covered by its children's points.
      const hasChildren = g.nodes.some((t) => t.parent_id === n.id);
      if (hasChildren && (n.level === 'UNIT' || !n.body)) continue;
      const unit = n.level === 'TOPIC' ? byId.get(n.parent_id) : n.level === 'UNIT' ? n : null;
      const section = unit && byId.get(unit.parent_id); // a framework section (subject) above a theme unit
      const heading = [doc.subject, g.grade_label, section && section.title, unit && unit.title, n.level === 'TOPIC' ? n.title : null]
        .filter(Boolean).join(' — ');
      const pieces = chunk([n.level === 'FRAMEWORK_SECTION' ? n.title : '', n.body].filter(Boolean).join('\n'));
      pieces.forEach((piece, i) => {
        points.push({
          id: uuidFrom(n.id, i),
          text: `${heading}\n${piece}`.trim(),
          payload: {
            curriculum_id: doc.curriculum_id,
            board: BOARD,
            programme: doc.programme,
            version: doc.version,
            exam_year: doc.exam_year,
            grade_label: g.grade_label,
            grade_number: g.grade_number,
            student_grade: g.student_grade,
            subject: doc.subject,
            level: n.level,
            node_id: n.id,
            parent_id: n.parent_id,
            unit_id: unit ? unit.id : null,
            unit_no: unit ? unit.ordinal : null,
            unit_title: unit ? unit.title : null,
            topic_id: n.level === 'TOPIC' ? n.id : null,
            topic_title: n.level === 'TOPIC' ? n.title : null,
            path: n.path,
            text: `${heading}\n${piece}`.trim(),
            chunk_index: i,
            chunk_count: pieces.length,
            source_id: doc.source.source_id,
            source_url: doc.source.final_url || doc.source.url,
            source_sha256: doc.source.sha256,
            page_from: n.page_from,
            page_to: n.page_to,
            extraction_method: extractionMethod(doc, n.page_from, n.page_to),
            provenance_status: doc.provenance_status,
            approved: false,
            content_origin: doc.content_origin,
            content_hash: n.content_hash,
            embedding_model: EMBEDDING_MODEL,
            pipeline_version: PIPELINE_VERSION,
            ingested_at: ingestedAt,
          },
        });
      });
    }
  }
  return points;
}

function assertCollection(name) {
  if (name !== CISCE_COLLECTION || PROTECTED_COLLECTIONS.includes(name)) {
    throw new Error(`refusing to write to Qdrant collection "${name}" — official CISCE data goes only to ${CISCE_COLLECTION}`);
  }
}

async function ensureCollection(client, name = CISCE_COLLECTION) {
  assertCollection(name);
  const { collections } = await client.getCollections();
  if (!collections.some((c) => c.name === name)) {
    await client.createCollection(name, { vectors: { size: VECTOR_SIZE, distance: 'Cosine' } });
  }
  for (const field of PAYLOAD_INDEXES) {
    await client.createPayloadIndex(name, { field_name: field, field_schema: 'keyword', wait: true }).catch(() => {});
  }
}

function createIndexer(client, embed, { dryRun = false, collection = CISCE_COLLECTION, log = () => {} } = {}) {
  assertCollection(collection);
  let ensured = false;
  return {
    async indexDocument(doc) {
      const points = buildPoints(doc);
      if (dryRun) return { planned: points.length, upserted: 0 };
      if (!ensured) { await ensureCollection(client, collection); ensured = true; }
      for (let i = 0; i < points.length; i += 64) {
        const batch = points.slice(i, i + 64);
        const withVectors = [];
        for (const p of batch) {
          const vector = await embed(p.text);
          if (!Array.isArray(vector) || vector.length !== VECTOR_SIZE) throw new Error(`embedding size ${vector?.length} != ${VECTOR_SIZE}`);
          withVectors.push({ id: p.id, vector, payload: p.payload });
        }
        await client.upsert(collection, { wait: true, points: withVectors });
      }
      // Points from an older copy of this source+version are removed.
      await client.delete(collection, {
        wait: true,
        filter: {
          must: [{ key: 'source_id', match: { value: doc.source.source_id } }, { key: 'version', match: { value: doc.version } }],
          must_not: [{ key: 'source_sha256', match: { value: doc.source.sha256 } }],
        },
      });
      log(`index ${doc.source.source_id}: ${points.length} point(s)`);
      return { planned: points.length, upserted: points.length };
    },
  };
}

// Lazy: @xenova/transformers is a devDependency (ingestion runs from a dev
// machine, not from the Cloud Run service), loaded only when indexing for real.
let pipe = null;
async function defaultEmbed(text) {
  if (!pipe) {
    const { pipeline } = await import('@xenova/transformers');
    pipe = await pipeline('feature-extraction', EMBEDDING_MODEL);
  }
  const out = await pipe(String(text).trim(), { pooling: 'mean', normalize: true });
  return Array.from(out.data);
}

module.exports = { buildPoints, createIndexer, ensureCollection, assertCollection, chunk, defaultEmbed, PAYLOAD_INDEXES };
