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
