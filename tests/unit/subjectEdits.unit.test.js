const { scopeOf } = require('../../services/subjectEdits/scope');
const { validateSubjectEdits, SubjectEditsValidationError } = require('../../services/subjectEdits/validation');

describe('scopeOf', () => {
  test('spellings of the same subject path share one key', () => {
    const a = scopeOf({ curriculum: 'NCERT', grade: 'Grade 6', subject: 'Maths' });
    const b = scopeOf({ curriculum: 'CBSE', grade: '6', subject: 'Mathematics' });
    expect(a).toEqual({ curriculum: 'cbse', grade: '6', subject: 'mathematics' });
    expect(b).toEqual(a);
  });

  test('missing parts give no scope', () => {
    expect(scopeOf({ curriculum: 'CBSE', grade: '6' })).toBeNull();
  });
});

describe('validateSubjectEdits', () => {
  test('keeps the outline and only lesson fields of each topic', () => {
    const out = validateSubjectEdits({
      chapters: [{ key: 'c1', title: 'Numbers', hidden: false, topics: [{ key: 'c1::t1', hidden: true }, { key: 'new-1', name: 'My topic', added: true }] }],
      topics: { 'c1::t1': { blocks: [{ type: 'explanation', text: 'Hi' }], whatYoullLearn: ['x'], evil: 'drop me' } },
      extra: 1,
    });
    expect(out.chapters[0]).toEqual({ key: 'c1', title: 'Numbers', topics: [{ key: 'c1::t1', hidden: true }, { key: 'new-1', name: 'My topic', added: true }] });
    expect(out.topics['c1::t1']).toEqual({ blocks: [{ type: 'explanation', text: 'Hi' }], whatYoullLearn: ['x'] });
    expect(out).not.toHaveProperty('extra');
  });

  test('rejects a chapter without a key and oversized changes', () => {
    expect(() => validateSubjectEdits({ chapters: [{ title: 'x' }] })).toThrow(SubjectEditsValidationError);
    expect(() => validateSubjectEdits({ topics: { a: { blocks: [{ text: 'x'.repeat(3.2 * 1024 * 1024) }] } } })).toThrow(/too large/);
  });
});
