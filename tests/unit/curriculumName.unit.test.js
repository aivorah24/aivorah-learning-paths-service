const { normalizeCurriculum, isCbse, toQdrantCurriculum, normalizeCurriculumParams } = require('../../services/curriculumName');

describe('curriculumName', () => {
  test.each(['NCERT', 'ncert', ' Ncert ', 'N CERT', 'CBSE', 'cbse'])('normalizeCurriculum(%p) -> CBSE', (v) => {
    expect(normalizeCurriculum(v)).toBe('CBSE');
    expect(isCbse(v)).toBe(true);
  });

  test('other curricula are untouched (trimmed)', () => {
    expect(normalizeCurriculum(' IB PYP ')).toBe('IB PYP');
    expect(isCbse('Cambridge')).toBe(false);
    expect(normalizeCurriculum(undefined)).toBeUndefined();
  });

  // The single CBSE -> NCERT content mapping: a CBSE student and a legacy
  // NCERT student resolve to the exact same Qdrant key.
  test('toQdrantCurriculum maps CBSE and legacy NCERT to the same "NCERT" content key', () => {
    expect(toQdrantCurriculum('CBSE')).toBe('NCERT');
    expect(toQdrantCurriculum('NCERT')).toBe('NCERT');
    expect(toQdrantCurriculum('IB PYP')).toBe('IB PYP');
  });

  test('normalizeCurriculumParams rewrites query and body curriculum', () => {
    const req = { query: { curriculum: 'ncert', grade: '8' }, body: { curriculum: 'NCERT' } };
    const next = jest.fn();
    normalizeCurriculumParams(req, {}, next);
    expect(req.query).toEqual({ curriculum: 'CBSE', grade: '8' });
    expect(req.body.curriculum).toBe('CBSE');
    expect(next).toHaveBeenCalled();
  });
});
