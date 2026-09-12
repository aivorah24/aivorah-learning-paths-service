const { validateCurriculumFile, CurriculumFileValidationError, MAX_FILE_BYTES } = require('../../services/curriculumUpload/fileValidation');

function pdfBuffer() { return Buffer.concat([Buffer.from('%PDF-1.4\n'), Buffer.alloc(100)]); }
function zipBuffer() { return Buffer.concat([Buffer.from([0x50, 0x4b, 0x03, 0x04]), Buffer.alloc(100)]); }

describe('validateCurriculumFile', () => {
  test('accepts a valid PDF', () => {
    expect(() => validateCurriculumFile({
      buffer: pdfBuffer(), mimetype: 'application/pdf', originalname: 'syllabus.pdf',
    })).not.toThrow();
  });

  test('accepts a valid DOCX', () => {
    expect(() => validateCurriculumFile({
      buffer: zipBuffer(),
      mimetype: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      originalname: 'syllabus.docx',
    })).not.toThrow();
  });

  test('accepts a valid XLSX', () => {
    expect(() => validateCurriculumFile({
      buffer: zipBuffer(),
      mimetype: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      originalname: 'syllabus.xlsx',
    })).not.toThrow();
  });

  test('rejects a missing file', () => {
    expect(() => validateCurriculumFile(null)).toThrow(CurriculumFileValidationError);
  });

  test('rejects an empty buffer', () => {
    expect(() => validateCurriculumFile({ buffer: Buffer.alloc(0), mimetype: 'application/pdf', originalname: 'a.pdf' }))
      .toThrow(CurriculumFileValidationError);
  });

  test('rejects a file over the size limit', () => {
    const big = Buffer.concat([Buffer.from('%PDF-'), Buffer.alloc(MAX_FILE_BYTES)]);
    expect(() => validateCurriculumFile({ buffer: big, mimetype: 'application/pdf', originalname: 'a.pdf' }))
      .toThrow(/exceeds/);
  });

  test('rejects an unsupported mimetype', () => {
    expect(() => validateCurriculumFile({ buffer: pdfBuffer(), mimetype: 'image/png', originalname: 'a.png' }))
      .toThrow(/Unsupported file type/);
  });

  test('rejects a mismatched extension for the declared mimetype', () => {
    expect(() => validateCurriculumFile({ buffer: pdfBuffer(), mimetype: 'application/pdf', originalname: 'a.docx' }))
      .toThrow(/extension does not match/);
  });

  test('rejects a PDF-labeled file with no PDF signature (spoofed mimetype)', () => {
    expect(() => validateCurriculumFile({ buffer: Buffer.alloc(50), mimetype: 'application/pdf', originalname: 'a.pdf' }))
      .toThrow(/corrupted or does not match/);
  });

  test('rejects a DOCX-labeled file with no zip signature', () => {
    expect(() => validateCurriculumFile({
      buffer: Buffer.alloc(50),
      mimetype: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      originalname: 'a.docx',
    })).toThrow(/corrupted or does not match/);
  });
});
