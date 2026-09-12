const {
  normalizeCurriculumStructure,
  validateNormalizedCurriculum,
  CurriculumNormalizationError,
} = require('../../services/curriculumUpload/normalization');

describe('normalizeCurriculumStructure — text sources (pdf/docx)', () => {
  test('parses "Chapter N: Title" / "Unit N: Title" as top-level units', () => {
    const text = 'Chapter 1: Numbers\nSome intro text.\nUnit 2: Algebra\nMore text.';
    const normalized = normalizeCurriculumStructure({ format: 'pdf', text });

    expect(normalized.sourceFormat).toBe('pdf');
    expect(normalized.unstructured).toBe(false);
    expect(normalized.units.map((u) => u.title)).toEqual(['Numbers', 'Algebra']);
    expect(normalized.units[0].content).toEqual(['Some intro text.']);
  });

  test('parses dotted numbering into unit -> topic -> subtopic depth', () => {
    const text = [
      '1 Numbers',
      '1.1 Whole Numbers',
      '1.1.1 Addition',
      '1.1.2 Subtraction',
      '1.2 Fractions',
      '2 Algebra',
    ].join('\n');

    const normalized = normalizeCurriculumStructure({ format: 'docx', text });

    expect(normalized.units).toHaveLength(2);
    const [numbers, algebra] = normalized.units;
    expect(numbers.title).toBe('Numbers');
    expect(numbers.topics.map((t) => t.title)).toEqual(['Whole Numbers', 'Fractions']);
    expect(numbers.topics[0].subtopics.map((s) => s.title)).toEqual(['Addition', 'Subtraction']);
    expect(algebra.title).toBe('Algebra');
    expect(algebra.topics).toEqual([]);
  });

  test('preserves source ordering across units, topics and subtopics', () => {
    const text = '1 A\n1.1 A1\n1.2 A2\n2 B\n2.1 B1';
    const normalized = normalizeCurriculumStructure({ format: 'pdf', text });

    expect(normalized.units.map((u) => u.order)).toEqual([0, 1]);
    expect(normalized.units[0].topics.map((t) => t.order)).toEqual([0, 1]);
    expect(normalized.units[1].topics.map((t) => t.order)).toEqual([0]);
  });

  test('handles a document with no detectable heading pattern without inventing structure', () => {
    const text = 'This is just a plain paragraph.\nAnother line of prose.';
    const normalized = normalizeCurriculumStructure({ format: 'pdf', text });

    expect(normalized.unstructured).toBe(true);
    expect(normalized.units).toHaveLength(1);
    expect(normalized.units[0].title).toBeNull();
    expect(normalized.units[0].content).toEqual(['This is just a plain paragraph.', 'Another line of prose.']);
  });

  test('keeps text before the first heading as preambleText rather than discarding it', () => {
    const text = 'Introduction line.\nChapter 1: Numbers\nBody text.';
    const normalized = normalizeCurriculumStructure({ format: 'pdf', text });

    expect(normalized.preambleText).toBe('Introduction line.');
    expect(normalized.units[0].title).toBe('Numbers');
  });

  test('rejects extracted_structure without a text field', () => {
    expect(() => normalizeCurriculumStructure({ format: 'pdf' })).toThrow(CurriculumNormalizationError);
  });
});

describe('normalizeCurriculumStructure — "Topic N: Title" keyword headings (regression for the empty-topics bug)', () => {
  test('"Topic N: Title" becomes a real topic under the current unit', () => {
    const text = 'Unit 1: Number Systems\nTopic 1: Knowing Our Numbers\nTopic 2: Whole Numbers';
    const normalized = normalizeCurriculumStructure({ format: 'docx', text });
    expect(normalized.units[0].topics.map((t) => t.title)).toEqual(['Knowing Our Numbers', 'Whole Numbers']);
  });

  test('"Topic N - Title" (dash separator) is also recognized', () => {
    const text = 'Unit 1: Algebra\nTopic 1 - Variables\nTopic 2 - Expressions';
    const normalized = normalizeCurriculumStructure({ format: 'docx', text });
    expect(normalized.units[0].topics.map((t) => t.title)).toEqual(['Variables', 'Expressions']);
  });

  test('bare numeric topic headings ("1.1 Title") still work alongside keyword headings', () => {
    const text = 'Unit 1: Numbers\n1.1 Whole Numbers\nTopic 2: Fractions';
    const normalized = normalizeCurriculumStructure({ format: 'docx', text });
    expect(normalized.units[0].topics.map((t) => t.title)).toEqual(['Whole Numbers', 'Fractions']);
  });

  test('a "Subtopics" label followed by plain lines becomes subtopics[], not flattened content', () => {
    const text = [
      'Unit 1: Number Systems',
      'Topic 1: Knowing Our Numbers',
      'Subtopics',
      'Reading and writing large numbers',
      'Place value and face value',
      'Suggested Learning Objectives',
      'Explain the main concepts.',
    ].join('\n');
    const normalized = normalizeCurriculumStructure({ format: 'docx', text });
    const topic = normalized.units[0].topics[0];
    expect(topic.subtopics.map((s) => s.title)).toEqual(['Reading and writing large numbers', 'Place value and face value']);
    expect(topic.content).toEqual(['Suggested Learning Objectives', 'Explain the main concepts.']);
  });

  test('subtopic collection stops at the next Topic heading', () => {
    const text = [
      'Unit 1: Numbers',
      'Topic 1: A',
      'Subtopics',
      'A1',
      'A2',
      'Topic 2: B',
      'Subtopics',
      'B1',
    ].join('\n');
    const normalized = normalizeCurriculumStructure({ format: 'docx', text });
    expect(normalized.units[0].topics[0].subtopics.map((s) => s.title)).toEqual(['A1', 'A2']);
    expect(normalized.units[0].topics[1].subtopics.map((s) => s.title)).toEqual(['B1']);
  });

  test('documents without any Subtopics section still produce topics with an empty subtopics array', () => {
    const text = 'Unit 1: Numbers\nTopic 1: Whole Numbers\nSome descriptive text.';
    const normalized = normalizeCurriculumStructure({ format: 'docx', text });
    expect(normalized.units[0].topics[0].subtopics).toEqual([]);
    expect(normalized.units[0].topics[0].content).toEqual(['Some descriptive text.']);
  });

  test('a "Subtopics" label with no current topic is ignored rather than crashing', () => {
    const text = 'Subtopics\nOrphan line\nUnit 1: Numbers';
    expect(() => normalizeCurriculumStructure({ format: 'docx', text })).not.toThrow();
  });
});

describe('normalizeCurriculumStructure — Grade/Subject/Curriculum metadata', () => {
  test('parses Grade:, Subject: and Curriculum: lines deterministically', () => {
    const text = 'Grade: 6\nSubject: Mathematics\nCurriculum: NCERT\nUnit 1: Numbers';
    const normalized = normalizeCurriculumStructure({ format: 'docx', text });
    expect(normalized.metadata).toEqual({ grade: '6', subject: 'Mathematics', curriculum: 'NCERT' });
  });

  test('missing/optional metadata does not throw and yields an empty object', () => {
    const text = 'Unit 1: Numbers\nTopic 1: Whole Numbers';
    const normalized = normalizeCurriculumStructure({ format: 'docx', text });
    expect(normalized.metadata).toEqual({});
  });

  test('only the first occurrence of a metadata key is kept', () => {
    const text = 'Grade: 6\nGrade: 7\nUnit 1: Numbers';
    const normalized = normalizeCurriculumStructure({ format: 'docx', text });
    expect(normalized.metadata.grade).toBe('6');
  });
});

describe('normalizeCurriculumStructure — real Grade 6 Mathematics test document (regression)', () => {
  const REAL_DOCX_TEXT = [
    'Grade 6 Mathematics Curriculum',
    'Teacher Curriculum -> Learning Path Test Document',
    'Grade: 6',
    'Subject: Mathematics',
    'Purpose: Test curriculum upload, extraction, normalization, AI learning-path generation, teacher review/edit, and publishing.',
    'Unit 1: Number Systems',
    'This unit develops foundational mathematical understanding through concepts, examples, practice, and application.',
    'Topic 1: Knowing Our Numbers',
    'Students will understand the key ideas in this topic and apply them to age-appropriate mathematical problems.',
    'Subtopics',
    'Reading and writing large numbers',
    'Place value and face value',
    'Comparing and ordering numbers',
    'Suggested Learning Objectives',
    'Explain the main concepts of 1: Knowing Our Numbers. Apply the concepts to solve appropriate mathematical problems.',
    'Topic 2: Whole Numbers',
    'Students will understand the key ideas in this topic and apply them to age-appropriate mathematical problems.',
    'Subtopics',
    'Number line',
    'Successor and predecessor',
    'Properties of whole numbers',
    'Suggested Learning Objectives',
    'Explain the main concepts of 2: Whole Numbers. Apply the concepts to solve appropriate mathematical problems.',
    'Unit 2: Fractions and Decimals',
    'This unit develops foundational mathematical understanding through concepts, examples, practice, and application.',
    'Topic 1: Understanding Fractions',
    'Students will understand the key ideas in this topic and apply them to age-appropriate mathematical problems.',
    'Subtopics',
    'Types of fractions',
    'Equivalent fractions',
    'Comparing fractions',
    'Suggested Learning Objectives',
    'Explain the main concepts of 1: Understanding Fractions. Apply the concepts to solve appropriate mathematical problems.',
    'Topic 2: Decimals',
    'Students will understand the key ideas in this topic and apply them to age-appropriate mathematical problems.',
    'Subtopics',
    'Reading decimal numbers',
    'Comparing decimals',
    'Fractions and decimals',
    'Suggested Learning Objectives',
    'Explain the main concepts of 2: Decimals. Apply the concepts to solve appropriate mathematical problems.',
    'Unit 3: Geometry',
    'This unit develops foundational mathematical understanding through concepts, examples, practice, and application.',
    'Topic 1: Basic Geometrical Ideas',
    'Students will understand the key ideas in this topic and apply them to age-appropriate mathematical problems.',
    'Subtopics',
    'Points, lines and line segments',
    'Rays and angles',
    'Parallel and intersecting lines',
    'Suggested Learning Objectives',
    'Explain the main concepts of 1: Basic Geometrical Ideas. Apply the concepts to solve appropriate mathematical problems.',
    'Topic 2: Understanding Shapes',
    'Students will understand the key ideas in this topic and apply them to age-appropriate mathematical problems.',
    'Subtopics',
    'Triangles and quadrilaterals',
    'Properties of common shapes',
    'Symmetry',
    'Suggested Learning Objectives',
    'Explain the main concepts of 2: Understanding Shapes. Apply the concepts to solve appropriate mathematical problems.',
    'Assessment Guidance',
    'Assess understanding using short-answer questions, worked examples, problem-solving activities, and application-based exercises.',
  ].join('\n');

  test('produces exactly 3 units, 6 topics, 18 subtopics, and Grade 6 / Mathematics metadata — never silently loses topics into unit.content again', () => {
    const normalized = normalizeCurriculumStructure({ format: 'docx', text: REAL_DOCX_TEXT });

    expect(normalized.units).toHaveLength(3);
    expect(normalized.units.map((u) => u.title)).toEqual(['Number Systems', 'Fractions and Decimals', 'Geometry']);

    const totalTopics = normalized.units.reduce((sum, u) => sum + u.topics.length, 0);
    expect(totalTopics).toBe(6);

    const totalSubtopics = normalized.units.reduce(
      (sum, u) => sum + u.topics.reduce((s, t) => s + t.subtopics.length, 0), 0
    );
    expect(totalSubtopics).toBe(18);

    expect(normalized.metadata).toEqual({ grade: '6', subject: 'Mathematics' });

    // Each topic must retain its own descriptive text as source-grounding context.
    const knowingOurNumbers = normalized.units[0].topics[0];
    expect(knowingOurNumbers.content.join(' ')).toContain('Explain the main concepts of 1: Knowing Our Numbers');
  });
});

describe('normalizeCurriculumStructure — xlsx sources', () => {
  test('builds a hierarchy from a sheet with recognizable chapter/topic/subtopic columns', () => {
    const sheets = [{
      name: 'Grade 6 Maths',
      rows: [
        ['Chapter', 'Topic', 'Subtopic'],
        ['Numbers', 'Whole Numbers', 'Addition'],
        ['Numbers', 'Whole Numbers', 'Subtraction'],
        ['Numbers', 'Fractions', ''],
        ['Algebra', 'Basics', ''],
      ],
    }];

    const normalized = normalizeCurriculumStructure({ format: 'xlsx', sheets });

    expect(normalized.unstructured).toBe(false);
    expect(normalized.units.map((u) => u.title)).toEqual(['Numbers', 'Algebra']);
    const numbers = normalized.units[0];
    expect(numbers.topics.map((t) => t.title)).toEqual(['Whole Numbers', 'Fractions']);
    expect(numbers.topics[0].subtopics.map((s) => s.title)).toEqual(['Addition', 'Subtraction']);
  });

  test('falls back to one topic per row when no topic column is recognizable', () => {
    const sheets = [{
      name: 'Sheet1',
      rows: [
        ['Column A', 'Column B'],
        ['Fractions', 'notes'],
        ['Decimals', 'notes'],
      ],
    }];

    const normalized = normalizeCurriculumStructure({ format: 'xlsx', sheets });

    expect(normalized.units).toHaveLength(1);
    expect(normalized.units[0].title).toBe('Sheet1');
    expect(normalized.units[0].topics.map((t) => t.title)).toEqual(['Fractions', 'Decimals']);
  });

  test('preserves row/sheet ordering across multiple sheets', () => {
    const sheets = [
      { name: 'S1', rows: [['Topic'], ['A'], ['B']] },
      { name: 'S2', rows: [['Topic'], ['C']] },
    ];
    const normalized = normalizeCurriculumStructure({ format: 'xlsx', sheets });
    expect(normalized.units.map((u) => u.title)).toEqual(['S1', 'S2']);
    expect(normalized.units.map((u) => u.order)).toEqual([0, 1]);
  });

  test('skips a sheet with only a header row (no data)', () => {
    const sheets = [{ name: 'Empty', rows: [['Chapter', 'Topic']] }];
    const normalized = normalizeCurriculumStructure({ format: 'xlsx', sheets });
    expect(normalized.units).toEqual([]);
    expect(normalized.unstructured).toBe(true);
  });

  test('rejects extracted_structure without a sheets array', () => {
    expect(() => normalizeCurriculumStructure({ format: 'xlsx' })).toThrow(CurriculumNormalizationError);
  });
});

describe('normalizeCurriculumStructure — malformed input', () => {
  test('rejects a null extracted_structure', () => {
    expect(() => normalizeCurriculumStructure(null)).toThrow(CurriculumNormalizationError);
  });

  test('rejects an unsupported format', () => {
    expect(() => normalizeCurriculumStructure({ format: 'txt', text: 'x' })).toThrow(CurriculumNormalizationError);
  });
});

describe('validateNormalizedCurriculum', () => {
  test('accepts a well-formed normalized structure', () => {
    const normalized = normalizeCurriculumStructure({ format: 'pdf', text: 'Chapter 1: Numbers\nSome text.' });
    expect(validateNormalizedCurriculum(normalized)).toBe(true);
  });

  test('accepts a valid unstructured document', () => {
    const normalized = normalizeCurriculumStructure({ format: 'pdf', text: 'Plain paragraph with no headings.' });
    expect(validateNormalizedCurriculum(normalized)).toBe(true);
  });

  test('rejects a structure with no units', () => {
    expect(() => validateNormalizedCurriculum({ sourceFormat: 'pdf', units: [] })).toThrow(CurriculumNormalizationError);
  });

  test('rejects a structure with an invalid sourceFormat', () => {
    expect(() => validateNormalizedCurriculum({ sourceFormat: 'bogus', units: [{ order: 0, topics: [] }] }))
      .toThrow(CurriculumNormalizationError);
  });

  test('rejects a unit missing a topics array', () => {
    expect(() => validateNormalizedCurriculum({ sourceFormat: 'pdf', units: [{ order: 0 }] }))
      .toThrow(CurriculumNormalizationError);
  });

  test('rejects a topic missing a numeric order', () => {
    const bad = { sourceFormat: 'pdf', units: [{ order: 0, topics: [{ title: 'x', subtopics: [] }] }] };
    expect(() => validateNormalizedCurriculum(bad)).toThrow(CurriculumNormalizationError);
  });

  test('rejects a structured (non-unstructured) result with no titled content anywhere', () => {
    const bad = { sourceFormat: 'pdf', unstructured: false, units: [{ order: 0, topics: [] }] };
    expect(() => validateNormalizedCurriculum(bad)).toThrow(CurriculumNormalizationError);
  });
});
