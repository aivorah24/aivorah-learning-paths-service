jest.setTimeout(30000); // real PDF parsing in child processes is slow under parallel load
// End-to-end CISCE pipeline with mocked network, Supabase, Qdrant and Cloudinary.
// Proves: dry run writes nothing; a real run writes only cisce_* tables and
// the cisce collection; re-runs are idempotent; --resume/--source/--stage
// work; and the existing AI-generated ICSE outline plus all CBSE/IB data are
// untouched, with the student Learning Path still showing ICSE as Coming soon.
const fs = require('fs');
const os = require('os');
const path = require('path');
const { memoryDb, memoryQdrant, fakeFetch, fakeEmbed, fixture } = require('../helpers/cisceMocks');

// Full pipeline runs parse real PDF fixtures; jest's 5s default flakes on a busy machine.
jest.setTimeout(30000);

const mockState = { db: null, qdrant: null };
jest.mock('../../services/supabase', () => new Proxy({}, { get: (_t, k) => mockState.db[k] }));
jest.mock('@qdrant/js-client-rest', () => ({
  QdrantClient: jest.fn().mockImplementation(() => ({
    scroll: async (collection, { filter }) => {
      const points = [...(mockState.qdrant.collections[collection]?.points.values() || [])].filter((p) => (filter?.must || []).every((c) => {
        const v = p.payload[c.key];
        return c.match.any ? c.match.any.includes(v) : v === c.match.value;
      }));
      return { points, next_page_offset: null };
    },
  })),
}));

const { runPipeline } = require('../../services/cisce/pipeline');
const { createHttp } = require('../../services/cisce/http');
const { listBoardSubjects, listBoardSyllabus } = require('../../services/boardSyllabus');
const { CISCE_COLLECTION } = require('../../services/cisce/constants');

const INDEX = 'https://cisce.org/regulations-and-syllabuses-icse-2/';
const Y28 = 'https://cisce.org/regulations-and-syllabuses-icse-2028/';
const PDF_A = 'https://cisce.org/wp-content/uploads/2026/01/98.-Testology.pdf';
const PDF_B = 'https://cisce.org/wp-content/uploads/2026/01/99.-Mockology.pdf';
const PDF_BROKEN = 'https://cisce.org/wp-content/uploads/2026/01/97.-Brokenology.pdf';
const REG = 'https://cisce.org/wp-content/uploads/2026/01/1.-Regulations.pdf';
const FRAMEWORK = 'https://cisce.org/wp-content/uploads/2025/03/PrimaryCurriculum.pdf';
const DEAD = 'https://cisce.org/wp-content/uploads/2025/02/1.-Regulations.pdf';

const ROUTES = {
  [INDEX]: { body: `<a href="${Y28}">ICSE 2028</a>`, contentType: 'text/html' },
  [Y28]: {
    contentType: 'text/html',
    body: `<a href="${REG}">Regulations</a><a href="${PDF_A}">Testology</a><a href="${PDF_BROKEN}">Brokenology</a>
      <div data-ra-element-link="{&quot;link&quot;:{&quot;url&quot;:&quot;${PDF_B.replace(/\//g, '\\/')}&quot;}}"></div>`,
  },
  [PDF_A]: { body: fixture('syllabus-text.pdf'), contentType: 'application/pdf' },
  [PDF_B]: { body: fixture('scanned-mixed.pdf'), contentType: 'application/pdf' },
  [PDF_BROKEN]: { body: fixture('corrupt.pdf'), contentType: 'application/pdf' },
  [REG]: { body: fixture('framework.pdf'), contentType: 'application/pdf' },
  [FRAMEWORK]: { body: fixture('framework.pdf'), contentType: 'application/pdf' },
};

// Existing data that must survive untouched.
const AI_ICSE = [
  { id: 'ai-1', grade: 'Class I', subject: 'Mathematics', curriculum: 'ICSE', school_id: null, unit_no: 1, title: 'Numbers to 100' },
  { id: 'ai-2', grade: 'Class I', subject: 'English', curriculum: 'ICSE', school_id: null, unit_no: 1, title: 'Rhymes' },
  { id: 'ai-3', grade: 'Class II', subject: 'Mathematics', curriculum: 'ICSE', school_id: null, unit_no: 1, title: 'Addition' },
];
const SEED = {
  syllabus_chapters: [...AI_ICSE, { id: 'cbse-1', grade: '8', subject: 'Science', curriculum: 'CBSE', school_id: null, unit_no: 1, title: 'Crop Production' }],
  syllabus_topics: [{ id: 't-1', chapter_id: 'ai-1', topic_order: 1, name: 'Counting' }, { id: 't-cbse', chapter_id: 'cbse-1', topic_order: 1, name: 'Agriculture' }],
  topic_resources: [{ id: 'r-1', topic_id: 't-1', resource_type: 'AI_EXPLANATION' }],
};
const seedQdrant = (q) => {
  q.collections.ai_mentor_content = { points: new Map([
    ['p1', { id: 'p1', payload: { curriculum: 'ICSE', grade: 'Class I', subject: 'Mathematics', topic: 'Counting', seeder: 'curriculum-ingestion-service' } }],
    ['p2', { id: 'p2', payload: { curriculum: 'IB PYP', grade: 'Grade 3', subject: 'Maths', topic: 'Patterns' } }],
  ]) };
  q.collections.aivorah_curriculum_chunks_v1 = { points: new Map([['n1', { id: 'n1', payload: { curriculum: 'NCERT', grade: 'Grade 8' } }]]) };
};

let tmp; let registryPath; let cacheDir; let coverageDir; let fetchImpl;
const DEV = { SUPABASE_URL: 'https://evlqkcozespsfrnuhevf.supabase.co', QDRANT_URL: 'http://qdrant.test' };

function writeRegistry() {
  fs.writeFileSync(registryPath, JSON.stringify({
    schema_version: 1,
    sources: [
      { id: 'icse-index', url: INDEX, kind: 'INDEX_PAGE', programme: 'ICSE' },
      { id: 'primary-curriculum', url: FRAMEWORK, kind: 'FRAMEWORK_PDF', programme: 'PRIMARY' },
      { id: 'dead-reg', url: DEAD, kind: 'REGULATIONS_PDF', programme: 'ICSE', link_status: 'DEAD', http_status: 404 },
    ],
    awaiting_sources: [{ id: 'awaiting-preschool-framework', programme: 'PRESCHOOL' }],
  }));
}

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cisce-it-'));
  registryPath = path.join(tmp, 'registry.json');
  cacheDir = path.join(tmp, 'cache');
  coverageDir = path.join(tmp, 'coverage');
  writeRegistry();
  mockState.db = memoryDb(SEED);
  mockState.qdrant = memoryQdrant();
  seedQdrant(mockState.qdrant);
  fetchImpl = fakeFetch(ROUTES);
});
afterEach(() => fs.rmSync(tmp, { recursive: true, force: true }));

const deps = (over = {}) => ({
  http: createHttp({ fetchImpl, sleep: async () => {}, minIntervalMs: 0 }),
  db: mockState.db, qdrant: mockState.qdrant, embed: fakeEmbed, ocr: null, env: DEV,
  uploadPrivateFile: jest.fn(), ...over,
});
const run = (opts = {}, d = deps()) => runPipeline({ registryPath, cacheDir, coverageDir, concurrency: 2, checkSupplementary: true, ...opts }, d);
const snapshotExisting = () => JSON.stringify({
  chapters: mockState.db.tables.syllabus_chapters, topics: mockState.db.tables.syllabus_topics, resources: mockState.db.tables.topic_resources,
  ib: [...mockState.qdrant.collections.ai_mentor_content.points.entries()], ncert: [...mockState.qdrant.collections.aivorah_curriculum_chunks_v1.points.entries()],
});

test('dry run: discovers, downloads, extracts and reports — but writes nothing to Supabase or Qdrant', async () => {
  const before = snapshotExisting();
  const r = await run({ dryRun: true, stages: undefined });
  expect(r.discovered.length).toBeGreaterThanOrEqual(5);
  expect(mockState.db.calls.filter((c) => c.op !== 'select')).toHaveLength(0);
  expect(mockState.qdrant.calls).toHaveLength(0);
  expect(mockState.qdrant.collections[CISCE_COLLECTION]).toBeUndefined();
  expect(r.planned.some((p) => p.op === 'qdrant-upsert' && p.points > 0)).toBe(true);
  expect(snapshotExisting()).toBe(before);
  // Coverage is still produced, from what was really extracted.
  expect(fs.readdirSync(coverageDir).sort()).toEqual([expect.stringMatching(/\.json$/), expect.stringMatching(/\.md$/)]);
});

test('real run on Dev: only cisce_* tables and the cisce collection are written; existing data untouched', async () => {
  const before = snapshotExisting();
  const ladderBefore = await listBoardSubjects('ICSE', 'Grade 1');
  const r = await run();

  const writtenTables = new Set(mockState.db.calls.filter((c) => c.op !== 'select').map((c) => c.table));
  expect([...writtenTables].every((t) => t.startsWith('cisce_'))).toBe(true);
  expect(new Set(mockState.qdrant.calls.map((c) => c[1]))).toEqual(new Set([CISCE_COLLECTION]));
  expect(snapshotExisting()).toBe(before);

  // Official content landed in its own namespace.
  const nodes = mockState.db.tables.cisce_curriculum_nodes;
  expect(nodes.length).toBeGreaterThan(0);
  expect(nodes.every((n) => n.curriculum_id === 'cisce' && n.approved === false)).toBe(true);
  expect(mockState.qdrant.collections[CISCE_COLLECTION].points.size).toBeGreaterThan(0);

  // Regulations are metadata only; the broken PDF failed without stopping the run.
  const sources = Object.fromEntries(mockState.db.tables.cisce_sources.map((s) => [s.url, s]));
  expect(sources[REG]).toMatchObject({ link_status: 'VERIFIED', page_count: 1 });
  expect(nodes.some((n) => n.source_id === sources[REG].id)).toBe(false);
  expect(sources[PDF_BROKEN].link_status).toBe('INVALID_PDF');
  expect(sources[DEAD].link_status).toBe('DEAD');
  expect(fetchImpl.requests.some((q) => q.url === DEAD)).toBe(false);
  expect(sources[PDF_A]).toMatchObject({ http_status: 200, content_type: 'application/pdf', page_count: 2 });
  expect(sources[PDF_A].sha256).toMatch(/^[0-9a-f]{64}$/);

  // Coverage: honest statuses, AI rows labelled supplementary.
  const cell = (g, s) => r.coverage.rows.find((x) => x.grade_label === g && x.subject === s);
  expect(cell('Class IX', 'Testology').status).toBe('VERIFIED_OFFICIAL');
  expect(cell('Class IX', 'Mockology').status).toBe('OFFICIAL_PARTIAL'); // scanned page, no OCR
  expect(cell('Class IX', 'Brokenology').status).toBe('EXTRACTION_FAILED');
  expect(cell('Class I', 'Mathematics').status).toBe('SUPPLEMENTARY_ONLY');
  expect(cell('Class I', 'All subjects (framework)').status).toBe('OFFICIAL_PARTIAL');
  expect(cell('Preschool', 'All subjects').status).toBe('AWAITING_SOURCE');
  expect(mockState.db.tables.cisce_coverage.length).toBe(r.coverage.rows.length);

  // The student Learning Path for ICSE is unchanged and still Coming soon.
  const ladderAfter = await listBoardSubjects('ICSE', 'Grade 1');
  expect(ladderAfter).toEqual(ladderBefore);
  expect(ladderAfter.every((s) => s.comingSoon)).toBe(true);
  const syllabus = await listBoardSyllabus('ICSE', 'Grade 9', 'Testology');
  expect(syllabus).toEqual([]);
});

test('re-running is idempotent, and --resume skips downloads already done', async () => {
  await run();
  const nodes = mockState.db.tables.cisce_curriculum_nodes.map((n) => n.id).sort();
  const points = [...mockState.qdrant.collections[CISCE_COLLECTION].points.keys()].sort();
  const requestsBefore = fetchImpl.requests.length;

  await run({ resume: true, stages: ['download', 'extract', 'normalise', 'validate', 'persist', 'index'] });
  const pdfRequests = fetchImpl.requests.slice(requestsBefore).map((q) => q.url);
  expect(pdfRequests).not.toContain(PDF_A); // done for this sha256
  expect(pdfRequests).toContain(PDF_BROKEN); // failed last time → retried

  await run({ stages: ['persist', 'index'] });
  expect(mockState.db.tables.cisce_curriculum_nodes.map((n) => n.id).sort()).toEqual(nodes);
  expect([...mockState.qdrant.collections[CISCE_COLLECTION].points.keys()].sort()).toEqual(points);
});

test('--source and --stage limit the work', async () => {
  await run({ stages: ['discover'] });
  expect(fetchImpl.requests.map((q) => q.url).filter((u) => u.endsWith('.pdf'))).toEqual([]);
  const registry = JSON.parse(fs.readFileSync(registryPath, 'utf8'));
  const id = registry.sources.find((s) => s.url === PDF_A).id;

  const r = await run({ sourceIds: [id], stages: ['download', 'extract'] });
  expect(Object.keys(r.processed)).toEqual([id]);
  expect(fetchImpl.requests.map((q) => q.url).filter((u) => u.endsWith('.pdf'))).toEqual([PDF_A]);
  expect(fs.existsSync(path.join(cacheDir, 'sources', id, 'extraction.json'))).toBe(true);
  expect(fs.existsSync(path.join(cacheDir, 'sources', id, 'canonical.json'))).toBe(false);
});

test('a stage whose input is missing fails that source with a clear reason', async () => {
  await run({ stages: ['discover'] });
  const r = await run({ stages: ['extract'] });
  expect(Object.values(r.failures).every((f) => /run the download stage first/.test(f.reason))).toBe(true);
});

test('concurrency never exceeds the limit', async () => {
  let inFlight = 0; let peak = 0;
  const slowOcr = async () => { inFlight++; peak = Math.max(peak, inFlight); await new Promise((r) => setTimeout(r, 20)); inFlight--; return 'x'; };
  await run({ stages: ['discover', 'download'] });
  // Same scanned fixture for every PDF source so each one calls OCR.
  await run({ stages: ['extract'], concurrency: 2 }, deps({ ocr: slowOcr }));
  expect(peak).toBeLessThanOrEqual(2);
});

test('writes are refused for any project but Dev — before anything is fetched', async () => {
  for (const url of ['https://xmwzifxlpmgsrxgxsgan.supabase.co', 'https://abcdefghijklmnopqrst.supabase.co']) {
    await expect(run({}, deps({ env: { ...DEV, SUPABASE_URL: url } }))).rejects.toThrow();
  }
  expect(fetchImpl.requests).toHaveLength(0);
  expect(mockState.db.calls).toHaveLength(0);
});

test('Cloudinary: store stage refused without approval; with approval it uploads privately', async () => {
  await expect(run({ stages: ['store'] })).rejects.toThrow(/CISCE_CLOUDINARY_APPROVED_BY/);
  await expect(run({ stages: ['store'], storePdfs: true })).rejects.toThrow(/CISCE_CLOUDINARY_APPROVED_BY/);

  await run({ stages: ['discover', 'download'] });
  const upload = jest.fn().mockResolvedValue({ publicId: 'aivorah/cisce-official/x', type: 'authenticated' });
  await run({ stages: ['store'], storePdfs: true }, deps({ uploadPrivateFile: upload, env: { ...DEV, CISCE_CLOUDINARY_APPROVED_BY: 'owner' } }));
  expect(upload).toHaveBeenCalled();
  expect(upload.mock.calls.every(([, o]) => o.folder === 'aivorah/cisce-official')).toBe(true);
  const reg = JSON.parse(fs.readFileSync(registryPath, 'utf8'));
  expect(reg.sources.find((s) => s.url === PDF_A)).toMatchObject({ storage: 'CLOUDINARY_PRIVATE', storage_approved_by: 'owner' });

  // A full default run never uploads.
  const upload2 = jest.fn();
  await run({}, deps({ uploadPrivateFile: upload2 }));
  expect(upload2).not.toHaveBeenCalled();
});
