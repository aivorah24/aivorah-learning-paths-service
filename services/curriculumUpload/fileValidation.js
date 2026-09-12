const ALLOWED_TYPES = {
  'application/pdf': '.pdf',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document': '.docx',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': '.xlsx',
};

const MAX_FILE_BYTES = Number(process.env.CURRICULUM_MAX_FILE_MB || 25) * 1024 * 1024;

class CurriculumFileValidationError extends Error {}

function hasPdfSignature(buffer) {
  return buffer.slice(0, 5).toString('latin1') === '%PDF-';
}

// DOCX and XLSX are both Office Open XML (zip) containers — same magic
// bytes. Content-type is distinguished by declared mimetype/extension here;
// a corrupt/mislabeled zip is caught later when extraction actually opens it.
function hasZipSignature(buffer) {
  return buffer.length >= 2 && buffer[0] === 0x50 && buffer[1] === 0x4b;
}

function validateCurriculumFile(file) {
  if (!file || !file.buffer || file.buffer.length === 0) {
    throw new CurriculumFileValidationError('No file uploaded');
  }
  if (file.buffer.length > MAX_FILE_BYTES) {
    throw new CurriculumFileValidationError(`File exceeds ${MAX_FILE_BYTES / (1024 * 1024)}MB limit`);
  }

  const expectedExt = ALLOWED_TYPES[file.mimetype];
  if (!expectedExt) {
    throw new CurriculumFileValidationError('Unsupported file type. Only PDF, DOCX and XLSX are supported.');
  }
  if (!file.originalname || !file.originalname.toLowerCase().endsWith(expectedExt)) {
    throw new CurriculumFileValidationError('File extension does not match its content type');
  }

  const validSignature = expectedExt === '.pdf' ? hasPdfSignature(file.buffer) : hasZipSignature(file.buffer);
  if (!validSignature) {
    throw new CurriculumFileValidationError('File is corrupted or does not match its declared type');
  }
}

module.exports = { validateCurriculumFile, CurriculumFileValidationError, MAX_FILE_BYTES, ALLOWED_TYPES };
