// CISCE persist (Supabase), index (Qdrant), write guard and private Cloudinary upload.
jest.mock('cloudinary', () => {
  const uploader = { upload: jest.fn(), destroy: jest.fn() };
  return { v2: { config: jest.fn(), uploader } };
});
const path = require('path');
const cloudinary = require('cloudinary').v2;
const { extractPdf } = require('../../services/cisce/pdf');
const { normalise } = require('../../services/cisce/normalise');
const { createWriter, nodeRows } = require('../../services/cisce/persist');
const { createIndexer, buildPoints, assertCollection, chunk } = require('../../services/cisce/indexer');
const { assertDevTarget } = require('../../services/cisce/guard');
const { uploadPrivateFile } = require('../../services/curriculumUpload/cloudinaryStorage');
const { CISCE_COLLECTION } = require('../../services/cisce/constants');
const { memoryDb, memoryQdrant, fakeEmbed, FIXTURES } = require('../helpers/cisceMocks');

let doc;
beforeAll(async () => {
  const ex = await extractPdf(path.join(FIXTURES, 'syllabus-text.pdf'), { ocr: null });
  doc = normalise({
    id: 'icse-2028-testology', url: 'https://cisce.org/x.pdf', kind: 'SYLLABUS_PDF', programme: 'ICSE', exam_year: 2028,
    version: 'icse-2028', subject: 'Testology', grades: ['Class IX', 'Class X'], link_status: 'VERIFIED',
  }, ex);
});

describe('persist', () => {
  test('writes only cisce_* tables, parents before children, approved=false', async () => {
    const db = memoryDb();
    const w = createWriter(db);
    await w.persistDocument(doc);
    expect([...new Set(db.calls.map((c) => c.table))]).toEqual(['cisce_extractions', 'cisce_curriculum_nodes']);
    const rows = db.tables.cisce_curriculum_nodes;
    expect(rows.every((r) => r.curriculum_id === 'cisce' && r.approved === false && r.version === 'icse-2028')).toBe(true);
    const pos = new Map(rows.map((r, i) => [r.id, i]));
    expect(rows.filter((r) => r.parent_id).every((r) => pos.get(r.parent_id) < pos.get(r.id))).toBe(true);
  });

  test('re-running upserts in place (deterministic ids) — no duplicates', async () => {
    const db = memoryDb();
    const w = createWriter(db);
    await w.persistDocument(doc);
    const first = db.tables.cisce_curriculum_nodes.map((r) => r.id).sort();
    await w.persistDocument(doc);
    expect(db.tables.cisce_curriculum_nodes.map((r) => r.id).sort()).toEqual(first);
    expect(db.tables.cisce_extractions).toHaveLength(1);
  });

  test('a new copy of the same source replaces only that source+version\'s old nodes', async () => {
    const db = memoryDb({ cisce_curriculum_nodes: [
      { id: 'old', source_id: 'icse-2028-testology', version: 'icse-2028', source_sha256: 'stale' },
      { id: 'other-version', source_id: 'icse-2028-testology', version: 'icse-2027', source_sha256: 'stale' },
      { id: 'other-source', source_id: 'icse-2028-chemistry', version: 'icse-2028', source_sha256: 'stale' },
    ] });
    await createWriter(db).persistDocument(doc);
    const ids = db.tables.cisce_curriculum_nodes.map((r) => r.id);
    expect(ids).not.toContain('old');
    expect(ids).toEqual(expect.arrayContaining(['other-version', 'other-source']));
  });

  test('dry run makes no database calls but reports the plan', async () => {
    const db = memoryDb();
    const w = createWriter(db, { dryRun: true });
    await w.persistDocument(doc);
    expect(db.calls).toHaveLength(0);
    expect(w.planned.find((p) => p.op === 'upsert' && p.table === 'cisce_curriculum_nodes').rows).toBe(nodeRows(doc).length);
  });
});

describe('index', () => {
  const REQUIRED = ['curriculum_id', 'board', 'programme', 'version', 'exam_year', 'grade_label', 'grade_number', 'student_grade',
    'subject', 'level', 'node_id', 'parent_id', 'unit_id', 'unit_no', 'unit_title', 'topic_id', 'topic_title', 'path', 'text',
    'chunk_index', 'chunk_count', 'source_id', 'source_url', 'source_sha256', 'page_from', 'page_to', 'extraction_method',
    'provenance_status', 'approved', 'content_origin', 'content_hash', 'embedding_model', 'pipeline_version', 'ingested_at'];

  test('every point carries every payload field', () => {
    const points = buildPoints(doc);
    expect(points.length).toBeGreaterThan(0);
    for (const p of points) expect(Object.keys(p.payload).sort()).toEqual([...REQUIRED].sort());
    const topic = points.find((p) => p.payload.topic_title === 'Placeholder topic one');
    expect(topic.payload).toMatchObject({ curriculum_id: 'cisce', grade_label: 'Class IX', student_grade: 'Grade 9', unit_title: 'Synthetic Unit Alpha', approved: false, extraction_method: 'text' });
  });

  test('writes to cisce_curriculum_v1 only, 384-d cosine, idempotent point ids', async () => {
    const q = memoryQdrant();
    const ix = createIndexer(q, fakeEmbed);
    await ix.indexDocument(doc);
    const n = q.collections[CISCE_COLLECTION].points.size;
    await ix.indexDocument(doc);
    expect(q.collections[CISCE_COLLECTION].points.size).toBe(n);
    expect(Object.keys(q.collections)).toEqual([CISCE_COLLECTION]);
    expect(q.collections[CISCE_COLLECTION].cfg).toEqual({ vectors: { size: 384, distance: 'Cosine' } });
    expect(new Set(q.calls.map((c) => c[1]))).toEqual(new Set([CISCE_COLLECTION]));
  });

  test('refuses CBSE/IB/quiz collections', () => {
    for (const c of ['ai_mentor_content', 'aivorah_curriculum_chunks_v1', 'school_quizzes', 'anything_else']) {
      expect(() => assertCollection(c)).toThrow(/refusing/);
      expect(() => createIndexer(memoryQdrant(), fakeEmbed, { collection: c })).toThrow(/refusing/);
    }
  });

  test('dry run never touches Qdrant or the embedder', async () => {
    const q = memoryQdrant();
    const embed = jest.fn();
    const r = await createIndexer(q, embed, { dryRun: true }).indexDocument(doc);
    expect(r.planned).toBeGreaterThan(0);
    expect(q.calls).toHaveLength(0);
    expect(embed).not.toHaveBeenCalled();
  });

  test('rejects an embedding of the wrong size', async () => {
    await expect(createIndexer(memoryQdrant(), async () => [1, 2, 3]).indexDocument(doc)).rejects.toThrow(/embedding size/);
  });

  test('chunks long text at line/word boundaries', () => {
    const parts = chunk(`${'word '.repeat(400)}\n${'more '.repeat(400)}`, 1500);
    expect(parts.length).toBeGreaterThan(1);
    expect(parts.every((p) => p.length <= 1500)).toBe(true);
  });
});

describe('assertDevTarget', () => {
  test('allows only the Dev project', () => {
    expect(assertDevTarget({ SUPABASE_URL: 'https://evlqkcozespsfrnuhevf.supabase.co' })).toBe('evlqkcozespsfrnuhevf');
  });
  test.each([
    ['Test', 'https://xmwzifxlpmgsrxgxsgan.supabase.co'],
    ['aivorah-db README prod', 'https://jwlepxmclbkrmfzrumch.supabase.co'],
    ['unknown project', 'https://abcdefghijklmnopqrst.supabase.co'],
    ['not a supabase url', 'http://localhost:54321'],
  ])('refuses %s', (_n, url) => {
    expect(() => assertDevTarget({ SUPABASE_URL: url })).toThrow(/refusing|only writes/);
  });
  test('Test cannot be whitelisted via CISCE_EXPECTED_SUPABASE_REF', () => {
    expect(() => assertDevTarget({ SUPABASE_URL: 'https://xmwzifxlpmgsrxgxsgan.supabase.co', CISCE_EXPECTED_SUPABASE_REF: 'xmwzifxlpmgsrxgxsgan' })).toThrow();
  });
});

describe('uploadPrivateFile', () => {
  test('uploads as an authenticated raw asset (not publicly reachable), never overwriting', async () => {
    cloudinary.uploader.upload.mockResolvedValueOnce({ public_id: 'aivorah/cisce-official/x', type: 'authenticated' });
    await uploadPrivateFile(Buffer.from('%PDF-1.4'), { folder: 'aivorah/cisce-official', publicId: 'x', fileName: 'x.pdf' });
    expect(cloudinary.uploader.upload).toHaveBeenCalledWith(expect.any(String), expect.objectContaining({ type: 'authenticated', resource_type: 'raw', overwrite: false }));
  });
});
