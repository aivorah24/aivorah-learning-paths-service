const { gradeCalibrationNote } = require('../../services/curriculum/gradeCalibration');

describe('gradeCalibrationNote', () => {
  test('Foundational tier for grades 1-2', () => {
    expect(gradeCalibrationNote('1')).toMatch(/Foundational/);
    expect(gradeCalibrationNote('Grade 2')).toMatch(/Foundational/);
  });
  test('Preparatory tier for grades 3-5', () => {
    expect(gradeCalibrationNote('4')).toMatch(/Preparatory/);
  });
  test('Middle tier for grades 6-8', () => {
    expect(gradeCalibrationNote('7')).toMatch(/Middle/);
  });
  test('Grade 6 forbids exponent notation and requires the Indian numbering system', () => {
    const note = gradeCalibrationNote('6');
    expect(note).toMatch(/Middle/);
    expect(note).toMatch(/exponent/i);
    expect(note).toMatch(/Indian numbering system/i);
  });
  test('Secondary tier for grades 9-12', () => {
    expect(gradeCalibrationNote('11')).toMatch(/Secondary/);
  });
  test('no grade returns empty string', () => {
    expect(gradeCalibrationNote(undefined)).toBe('');
    expect(gradeCalibrationNote('')).toBe('');
  });
});
