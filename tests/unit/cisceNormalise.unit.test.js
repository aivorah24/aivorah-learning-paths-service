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
    expect(gradeFromHeading('PRE-PRIMARY CLASSES')).toBe('Preschool');
    expect(gradeFromHeading('Pre-primary education lays the foundation')).toBeNull();
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
    // Text before the first CLASS heading is the document preamble, kept once — not copied into each grade.
    expect(doc.preamble).toMatchObject({ page_from: 1, page_to: 1 });
    expect(doc.preamble.text).toMatch(/^TESTOLOGY\nAims:/);
    expect(x.nodes.every((n) => n.page_from === 2)).toBe(true);
    expect(ix.nodes.some((n) => /Aims/.test(n.body || ''))).toBe(false);
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

  test('theme-based framework: one section per CLASS heading, each with its own pages and subject, themes as units', async () => {
    const doc = normalise(source({ id: 'primary', kind: 'FRAMEWORK_PDF', programme: 'PRIMARY', subject: null, grades: [], version: null, exam_year: null }), await extract('theme-framework.pdf'));
    expect(doc.preamble).toMatchObject({ page_from: 1, page_to: 1 });
    const [one, two] = doc.grades;
    expect(one).toMatchObject({ grade_label: 'Class I', section_count: 2 });
    expect(two).toMatchObject({ grade_label: 'Class II', section_count: 2 });
    const summary = (g) => g.nodes.map((n) => [n.level, n.title, n.page_from, n.page_to]);
    expect(summary(one)).toEqual([
      ['FRAMEWORK_SECTION', 'SYNTHETIC LANGUAGE — Class I', 2, 2],
      ['FRAMEWORK_SECTION', 'SYNTHETIC NUMBERS — Class I', 3, 3],
      ['UNIT', 'Made-up Shapes Around Us', 3, 3],
      ['UNIT', 'Pretend Patterns', 3, 3],
    ]);
    expect(summary(two)).toEqual([
      ['FRAMEWORK_SECTION', 'SYNTHETIC LANGUAGE — Class II', 2, 2],
      ['FRAMEWORK_SECTION', 'SYNTHETIC NUMBERS — Class II', 3, 3],
    ]);
    // Theme units hang under their subject's section; no node starts on the cover page.
    expect(one.nodes[2].parent_id).toBe(one.nodes[1].id);
    expect(doc.grades.every((g) => g.nodes.every((n) => n.page_from > 1))).toBe(true);
    expect(doc.provenance_status).toBe('OFFICIAL_PARTIAL');
    expect(validateCanonical(doc).valid).toBe(true);
  });

  // Each case below is a layout from the first real Primary Curriculum run.
  describe('primary framework layouts', () => {
    let doc;
    const grade = (g) => doc.grades.find((x) => x.grade_label === g);
    const titles = (g) => grade(g).nodes.map((n) => n.title);
    beforeAll(async () => {
      doc = normalise(source({ id: 'primary', kind: 'FRAMEWORK_PDF', programme: 'PRIMARY', subject: null, grades: [], version: null, exam_year: null }), await extract('primary-layouts.pdf'));
    });

    test('a by-skill table with classes as columns is split into each class', () => {
      for (const [g, phonics] of [['Class I', 'Hears made-up sounds'], ['Class II', 'Blends sounds'], ['Class III', 'Reads made-up words']]) {
        const sec = grade(g).nodes.find((n) => /READING/.test(n.title));
        expect(sec.body.split('\n')[0]).toBe(`Phonics — ${phonics}`);
        expect(sec.page_from).toBe(2);
      }
      expect(doc.cross_class).toEqual([]);
    });

    test('a sentence that mentions pre-primary does not create a Preschool grade', () => {
      expect(doc.grades.map((g) => g.grade_label)).toEqual(['Class I', 'Class II', 'Class III']);
    });

    test('a topic title comes from the first table column only; the other columns are body', () => {
      const topic = grade('Class I').nodes.find((n) => n.level === 'TOPIC');
      expect(topic.title).toBe('Length');
      expect(topic.body).toMatch(/^Using concrete toy blocks/);
    });

    test('a lower-case sentence in a lettered list is body text, not a topic', () => {
      expect(grade('Class I').nodes.filter((n) => n.level === 'TOPIC')).toHaveLength(1);
      expect(titles('Class I').some((t) => /printing/.test(t))).toBe(false);
    });

    test('a heading wrapped over two lines is joined, and a repeated CLASS page header continues its section', () => {
      expect(titles('Class III')).toEqual(['INVENTED LANGUAGE READING — Class III', 'SOCIAL STUDIES — Class III']);
      const social = grade('Class III').nodes[1];
      expect([social.page_from, social.page_to]).toEqual([5, 6]);
      expect(social.body).not.toMatch(/SOCIAL|STUDIES/);
    });
  });

  test('multi-class text that cannot be split by column stays in cross_class with a warning', () => {
    const page = (n, text) => ({ page: n, method: 'text', text });
    const doc = normalise(source({ kind: 'FRAMEWORK_PDF', subject: null, grades: [] }), {
      sha256: 'a'.repeat(64), pageCount: 3, emptyPages: 0,
      pages: [page(1, 'WRITING'), page(2, 'Class I Class II Class III\nLearners write invented words across classes.'), page(3, 'CLASS I\nOwn section text here for class one.')],
    });
    expect(doc.cross_class).toEqual([{ context: 'WRITING', kind: 'unsplit_table', page_from: 2, page_to: 2, text: 'Learners write invented words across classes.' }]);
    expect(doc.warnings.join(' ')).toMatch(/could not be split by class/);
    expect(doc.grades.map((g) => g.grade_label)).toEqual(['Class I']);
    expect(doc.grades[0].nodes[0].body).toBe('Own section text here for class one.');
  });

  test('roman topics with a long heading or no space after ")" are still topics', () => {
    const doc = normalise(source({ grades: ['Class IX'] }), {
      sha256: 'b'.repeat(64), pageCount: 1, emptyPages: 0,
      pages: [{ page: 1, method: 'text', text: [
        'CLASS IX', '3. Laws of Motion',
        '(i) Contact and non-contact forces; cgs & SI units.',
        '(ii) Newton’s First Law of Motion (qualitative discussion) introduction of the idea of inertia, mass and force.',
        '(iii)Newton’s Second Law of Motion (including F=ma); weight and mass.',
        '(a) not a topic: a long lettered list item inside the topic body text goes on and on here.',
      ].join('\n') }],
    });
    const topics = doc.grades[0].nodes.filter((n) => n.level === 'TOPIC').map((n) => n.number_label);
    expect(topics).toEqual(['(i)', '(ii)', '(iii)']);
  });

  test('numbered lines that break the unit sequence (practical-work lists) are not units', () => {
    const doc = normalise(source({ grades: ['Class X'] }), {
      sha256: 'c'.repeat(64), pageCount: 1, emptyPages: 0,
      pages: [{ page: 1, method: 'text', text: [
        'CLASS X', '1. Force, Work, Power and Energy', '2. Light', '3. Sound',
        'PRACTICAL WORK', '2. Determine the VR and MA of a given pulley system.', '10. Determination of specific latent heat of ice.',
      ].join('\n') }],
    });
    expect(doc.grades[0].nodes.filter((n) => n.level === 'UNIT').map((n) => n.title)).toEqual(['Force, Work, Power and Energy', 'Light', 'Sound']);
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

// Layouts from the real Primary Curriculum PDF (346 pages), as page text.
describe('primary framework: subjects, bands and Hindi', () => {
  const page = (n, text) => ({ page: n, method: 'text', text });
  const run = (pages) => normalise(source({ id: 'primary', kind: 'FRAMEWORK_PDF', programme: 'PRIMARY', subject: null, grades: [], version: null, exam_year: null }),
    { sha256: 'a'.repeat(64), pageCount: pages.length, emptyPages: 0, pages });
  const sections = (doc, g) => doc.grades.find((x) => x.grade_label === g).nodes.filter((n) => n.level === 'FRAMEWORK_SECTION').map((n) => n.title);
  const units = (doc, g, title) => {
    const nodes = doc.grades.find((x) => x.grade_label === g).nodes;
    const sec = nodes.find((n) => n.title === title);
    // A class with a single section has no section node; its units are top level.
    return nodes.filter((n) => n.level === 'UNIT' && n.parent_id === (sec ? sec.id : null)).map((n) => n.title);
  };

  test('"CLASS - I | ENGLISH" is a class heading with its subject in the next cell', () => {
    const doc = run([page(1, 'ENGLISH\nWhy English matters.'), page(2, 'CLASS - I\tENGLISH\nListening and Speaking\nGreets and responds.')]);
    expect(sections(doc, 'Class I')).toEqual(['ENGLISH — Class I']);
    expect(doc.cross_class).toEqual([{ context: 'ENGLISH', kind: 'subject_intro', page_from: 1, page_to: 1, text: 'ENGLISH\nWhy English matters.' }]);
  });

  test('a new subject at the top of a page ends the previous class section', () => {
    const doc = run([page(1, 'ENGLISH LITERATURE'), page(2, 'Class V\nA made-up reading list.'), page(3, 'HINDI\nHindi intro text.'), page(4, 'MATHEMATICS\nCLASS - I\n1. Numbers\nCounting to twenty.')]);
    const v = doc.grades.find((g) => g.grade_label === 'Class V').nodes[0];
    expect([v.title, v.page_from, v.page_to]).toEqual(['ENGLISH LITERATURE — Class V', 2, 2]);
    expect(doc.cross_class.map((b) => b.context)).toEqual(['HINDI']);
  });

  test('a subject name in a contents list (not at the top of a page) starts nothing', () => {
    const doc = run([page(1, 'Contents\nENGLISH\nMATHEMATICS\nSubjects for Classes VI - VIII'), page(2, 'Classes VI - VIII'), page(3, 'MATHEMATICS\nCLASS - I\nCounting.')]);
    expect(doc.grades.map((g) => g.grade_label)).toEqual(['Class I']);
    expect(doc.preamble).toMatchObject({ page_from: 1, page_to: 2 });
  });

  test('a band heading is one section shared by each class in it, and its numbered list is not units', () => {
    const doc = run([page(1, 'ENVIRONMENTAL\nSTUDIES'), page(2, 'Classes I & II\nEVS aims for the band.\n1. Observation and Reporting'), page(3, 'CLASS - I\nTheme 1: About Me\nMy name.')]);
    expect(sections(doc, 'Class I')).toEqual(['ENVIRONMENTAL STUDIES — Class I (shared: Classes I–II)', 'ENVIRONMENTAL STUDIES — Class I']);
    expect(sections(doc, 'Class II')).toEqual(['ENVIRONMENTAL STUDIES — Class II (shared: Classes I–II)']);
    expect(units(doc, 'Class I', 'ENVIRONMENTAL STUDIES — Class I (shared: Classes I–II)')).toEqual([]);
    expect(units(doc, 'Class I', 'ENVIRONMENTAL STUDIES — Class I')).toEqual(['About Me']);
  });

  test('Arts: a theme above class bands becomes a unit in every band under it', () => {
    const doc = run([page(1, 'ARTS EDUCATION\nTheme 1: Form\nForm intro.\nCLASSES – I to III\nDraw shapes.\nCLASSES – IV & V\nSketch objects.\nTheme 2: Colour\nColour intro.\nCLASSES – I to III\nMix colours.')]);
    expect(units(doc, 'Class II', 'ARTS EDUCATION — Class II (shared: Classes I–III)')).toEqual(['Form', 'Colour']);
    expect(units(doc, 'Class V', 'ARTS EDUCATION — Class V (shared: Classes IV–V)')).toEqual(['Form']);
  });

  test('"Topic N:" lines are units, and a numbered line inside them is not', () => {
    const doc = run([page(1, 'COMPUTER STUDIES\nCLASS - II\nTopic 1: Keyboard\nKeys.\n2. Ctrl+alt+del\nRestarts.')]);
    expect(units(doc, 'Class II', 'COMPUTER STUDIES — Class II')).toEqual(['Keyboard']);
  });

  test('Hindi class headings are read, and unreadable Devanagari is flagged', () => {
    const doc = run([page(1, 'HINDI\nक�ा - I\nसुनना और बोलना �� �� ��')]);
    expect(sections(doc, 'Class I')).toEqual(['HINDI — Class I']);
    expect(doc.warnings.join(' ')).toMatch(/did not extract cleanly .* HINDI/);
  });

  test('a lone "Class III" line before a "Class IV | Class V" header is the same wrapped header, not a section', () => {
    const doc = run([page(1, 'SCIENCE\nCore concepts:\nClass III\nClass IV\tClass V\nLiving things\tHuman Body'), page(2, 'CLASS - III\nTheme 1: Plants\nLeaves.')]);
    expect(units(doc, 'Class III')).toEqual(['Plants']);
    expect(doc.grades.map((g) => g.grade_label)).toEqual(['Class III']);
    expect(doc.cross_class.find((b) => b.kind === 'unsplit_table').text).toMatch(/Living things/);
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
