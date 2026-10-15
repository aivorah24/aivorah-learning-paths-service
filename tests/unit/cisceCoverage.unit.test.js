// CISCE coverage report: statuses only from what was extracted; gaps stay gaps.
const { buildCoverage, coverageMarkdown, toLabel } = require('../../services/cisce/coverage');
const { withDefaults } = require('../../services/cisce/registry');
const { GRADE_LABELS } = require('../../services/cisce/constants');

const doc = (subject, provenance, grades) => ({
  subject, provenance_status: provenance, source: { source_id: `src-${subject}` },
  grades: grades.map((g) => ({ grade_label: g, nodes: [{ level: 'UNIT' }, { level: 'TOPIC' }, { level: 'TOPIC' }] })),
});
const cellOf = (r, g, s) => r.rows.find((x) => x.grade_label === g && x.subject === s);

test('no data at all: every grade Preschool–Class XII is AWAITING_SOURCE, nothing invented', () => {
  const r = buildCoverage({});
  expect(r.rows).toHaveLength(13);
  expect(r.rows.map((x) => x.grade_label)).toEqual(GRADE_LABELS);
  expect(r.rows.every((x) => x.status === 'AWAITING_SOURCE' && x.subject === 'All subjects' && x.topic_count === 0)).toBe(true);
  expect(r.supplementary_checked).toBe(false);
});

test('statuses follow the extracted documents', () => {
  const r = buildCoverage({
    documents: [doc('Physics', 'VERIFIED_OFFICIAL', ['Class IX', 'Class X']), doc('All subjects (framework)', 'OFFICIAL_PARTIAL', ['Class I'])],
  });
  expect(cellOf(r, 'Class IX', 'Physics')).toMatchObject({ status: 'VERIFIED_OFFICIAL', unit_count: 1, topic_count: 2 });
  expect(cellOf(r, 'Class I', 'All subjects (framework)')).toMatchObject({ status: 'OFFICIAL_PARTIAL', notes: 'framework only, no chapters' });
  expect(cellOf(r, 'Class V', 'All subjects').status).toBe('AWAITING_SOURCE');
  expect(r.summary['Class IX']).toMatchObject({ VERIFIED_OFFICIAL: 1 });
});

test('a primary-version syllabus that failed is EXTRACTION_FAILED; a dead historical one is not counted', () => {
  const registry = [
    withDefaults({ id: 'chem', kind: 'SYLLABUS_PDF', programme: 'ICSE', subject: 'Chemistry', is_primary_version: true, link_status: 'VERIFIED' }),
    withDefaults({ id: 'bio-old', kind: 'SYLLABUS_PDF', programme: 'ICSE', subject: 'Biology', is_primary_version: false, link_status: 'DEAD' }),
  ];
  const r = buildCoverage({ registry, failures: { chem: { stage: 'extract', reason: 'unparseable PDF' } } });
  expect(cellOf(r, 'Class IX', 'Chemistry')).toMatchObject({ status: 'EXTRACTION_FAILED' });
  expect(cellOf(r, 'Class IX', 'Chemistry').notes).toMatch(/extract failed/);
  expect(cellOf(r, 'Class X', 'Biology').status).toBe('AWAITING_SOURCE');
});

test('existing AI-generated ICSE rows show as SUPPLEMENTARY_ONLY, never as official', () => {
  const r = buildCoverage({
    documents: [doc('Mathematics', 'OFFICIAL_PARTIAL', ['Class II'])],
    supplementary: [{ grade: 'Class I', subject: 'Mathematics', chapters: 8 }, { grade: 'Class II', subject: 'Mathematics', chapters: 3 }],
  });
  expect(cellOf(r, 'Class I', 'Mathematics')).toMatchObject({ status: 'SUPPLEMENTARY_ONLY' });
  expect(cellOf(r, 'Class II', 'Mathematics').status).toBe('OFFICIAL_PARTIAL');
  expect(cellOf(r, 'Class II', 'Mathematics').notes).toMatch(/supplementary only/);
  expect(r.supplementary_checked).toBe(true);
});

test('grade labels map through boardSyllabus', () => {
  expect(toLabel('Class II')).toBe('Class II');
  expect(toLabel('Grade 2')).toBe('Class II');
  expect(toLabel('Pre-Primary')).toBe('Preschool');
});

test('markdown says when existing rows were not checked', () => {
  const md = coverageMarkdown(buildCoverage({}), { generatedAt: 'T' });
  expect(md).toMatch(/not checked/);
  expect(md).toMatch(/\| Class XII \| 0 \| 0 \| 0 \| 0 \| 1 \|/);
});
