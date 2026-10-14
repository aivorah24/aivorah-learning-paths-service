// CISCE normalise + validate: canonical JSON comes only from the document's own headings.
const path = require('path');
const { extractPdf } = require('../../services/cisce/pdf');
const { normalise, gradeFromHeading } = require('../../services/cisce/normalise');
const { validateCanonical } = require('../../services/cisce/validate');
const { GRADE_LABELS } = require('../../services/cisce/constants');
const { FIXTURES } = require('../helpers/cisceMocks');

const source = (over = {}) => ({
  id: 'icse-2028-testology', url: 'https://cisce.org/x/99.-Testology.pdf', kind: 'SYLLABUS_PDF', programme: 'ICSE',
  exam_year: 2028, version: 'icse-2028', subject: 'Testology', grades: ['Class IX', 'Class X'], link_status: 'VERIFIED', ...over,
});
const extract = (f) => extractPdf(path.join(FIXTURES, f), { ocr: null });

describe('grade labels', () => {
  test('Preschool + Class I..XII come from boardSyllabus.classLabel', () => {
    expect(GRADE_LABELS).toEqual(['Preschool', 'Class I', 'Class II', 'Class III', 'Class IV', 'Class V', 'Class VI',
      'Class VII', 'Class VIII', 'Class IX', 'Class X', 'Class XI', 'Class XII']);
    expect(gradeFromHeading('CLASS IX')).toBe('Class IX');
    expect(gradeFromHeading('CLASS – 10')).toBe('Class X');
    expect(gradeFromHeading('Pre-Primary')).toBe('Preschool');
    expect(gradeFromHeading('CLASS XIII')).toBeNull();
    expect(gradeFromHeading('Class IX students will study')).toBeNull();
  });
});

describe('normalise', () => {
  test('splits by CLASS heading into units and topics, with page numbers', async () => {
    const doc = normalise(source(), await extract('syllabus-text.pdf'));
    expect(doc).toMatchObject({ curriculum_id: 'cisce', board: 'CISCE', version: 'icse-2028', approved: false, content_origin: 'official_cisce', provenance_status: 'VERIFIED_OFFICIAL' });
    const [ix, x] = doc.grades;
    expect(ix).toMatchObject({ grade_label: 'Class IX', grade_number: 9, student_grade: 'Grade 9' });
    expect(x.grade_label).toBe('Class X');
    const units = ix.nodes.filter((n) => n.level === 'UNIT');
    expect(units.map((u) => u.title)).toEqual(['Synthetic Unit Alpha', 'Synthetic Unit Beta']);
    const topics = ix.nodes.filter((n) => n.level === 'TOPIC');
    expect(topics.map((t) => [t.path, t.number_label, t.title])).toEqual([
      ['1.1', '(i)', 'Placeholder topic one'], ['1.2', '(ii)', 'Placeholder topic two'], ['2.1', '(a)', 'Imaginary topic gamma'],
    ]);
    expect(topics[0].parent_id).toBe(units[0].id);
    expect(topics[0].body).toBe('Detail line for placeholder topic one.');
    expect(x.nodes.every((n) => n.page_from === 2)).toBe(false); // preamble from page 1 is shared framework text
    expect(x.nodes.find((n) => n.level === 'UNIT').page_from).toBe(2);
    expect(validateCanonical(doc)).toEqual({ valid: true, errors: [] });
  });

  test('ids are deterministic across runs and differ across versions', async () => {
    const ex = await extract('syllabus-text.pdf');
    const ids = (d) => d.grades.flatMap((g) => g.nodes.map((n) => n.id));
    expect(ids(normalise(source(), ex))).toEqual(ids(normalise(source(), ex)));
    const other = ids(normalise(source({ version: 'icse-2027', exam_year: 2027 }), ex));
    expect(other.some((id) => ids(normalise(source(), ex)).includes(id))).toBe(false);
  });

  test('a framework with no units/topics is OFFICIAL_PARTIAL, framework text only', async () => {
    const doc = normalise(source({ id: 'primary', kind: 'FRAMEWORK_PDF', programme: 'PRIMARY', subject: null, grades: [], version: null, exam_year: null }), await extract('framework.pdf'));
    expect(doc.provenance_status).toBe('OFFICIAL_PARTIAL');
    expect(doc.subject).toBe('All subjects (framework)');
    expect(doc.grades.map((g) => g.grade_label)).toEqual(['Class I', 'Class II']);
    expect(doc.grades.every((g) => g.nodes.every((n) => n.level === 'FRAMEWORK_SECTION'))).toBe(true);
    expect(validateCanonical(doc).valid).toBe(true);
  });

  test('an unread (scanned, no OCR) page downgrades to OFFICIAL_PARTIAL', async () => {
    const doc = normalise(source({ subject: 'Mockology' }), await extract('scanned-mixed.pdf'));
    expect(doc.provenance_status).toBe('OFFICIAL_PARTIAL');
    expect(doc.warnings.join(' ')).toMatch(/no text/);
  });

  test('an unverified source can never be VERIFIED_OFFICIAL', async () => {
    const doc = normalise(source({ link_status: 'UNVERIFIED' }), await extract('syllabus-text.pdf'));
    expect(doc.provenance_status).toBe('OFFICIAL_PARTIAL');
  });

  test('no CLASS heading and no declared grade: nothing is assigned to a guessed grade', async () => {
    const doc = normalise(source({ grades: [] }), { sha256: 'a'.repeat(64), pageCount: 1, emptyPages: 0, pages: [{ page: 1, method: 'text', text: '1. Unit\n(i) Topic' }] });
    expect(doc.grades).toEqual([]);
    expect(doc.warnings.join(' ')).toMatch(/not assigned to any grade/);
  });
});

describe('validateCanonical', () => {
  let doc;
  beforeEach(async () => { doc = normalise(source(), await extract('syllabus-text.pdf')); });

  test.each([
    ['wrong curriculum_id', (d) => { d.curriculum_id = 'icse'; }, /curriculum_id/],
    ['pre-approved', (d) => { d.approved = true; }, /approved/],
    ['AI origin', (d) => { d.content_origin = 'ai_generated'; }, /content_origin/],
    ['unknown grade', (d) => { d.grades[0].grade_label = 'Grade 9'; }, /unknown grade_label/],
    ['duplicate id', (d) => { d.grades[1].nodes[0].id = d.grades[0].nodes[0].id; }, /duplicate id/],
    ['page out of range', (d) => { d.grades[0].nodes[1].page_to = 99; }, /page_to out of range/],
    ['orphan topic', (d) => { d.grades[0].nodes.find((n) => n.level === 'TOPIC').parent_id = null; }, /topic parent/],
    ['VERIFIED_OFFICIAL from an unverified source', (d) => { d.source.link_status = 'UNVERIFIED'; }, /VERIFIED source/],
  ])('rejects %s', (_n, mutate, msg) => {
    mutate(doc);
    const v = validateCanonical(doc);
    expect(v.valid).toBe(false);
    expect(v.errors.join('\n')).toMatch(msg);
  });
});
