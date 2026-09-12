const pdfParse = require('pdf-parse');
const mammoth = require('mammoth');
const XLSX = require('xlsx');

class CurriculumExtractionError extends Error {}

async function extractPdf(buffer) {
  let result;
  try {
    result = await pdfParse(buffer);
  } catch (err) {
    throw new CurriculumExtractionError(`Failed to parse PDF: ${err.message}`);
  }
  return { format: 'pdf', text: (result.text || '').trim(), pageCount: result.numpages };
}

async function extractDocx(buffer) {
  let result;
  try {
    result = await mammoth.extractRawText({ buffer });
  } catch (err) {
    throw new CurriculumExtractionError(`Failed to parse DOCX: ${err.message}`);
  }
  return { format: 'docx', text: (result.value || '').trim() };
}

function extractXlsx(buffer) {
  let workbook;
  try {
    workbook = XLSX.read(buffer, { type: 'buffer' });
  } catch (err) {
    throw new CurriculumExtractionError(`Failed to parse XLSX: ${err.message}`);
  }
  if (!workbook.SheetNames || workbook.SheetNames.length === 0) {
    throw new CurriculumExtractionError('XLSX file contains no sheets');
  }
  const sheets = workbook.SheetNames.map((name) => ({
    name,
    rows: XLSX.utils.sheet_to_json(workbook.Sheets[name], { header: 1, blankrows: false }),
  }));
  return { format: 'xlsx', sheets };
}

async function extractCurriculumContent(buffer, mimeType) {
  switch (mimeType) {
    case 'application/pdf':
      return extractPdf(buffer);
    case 'application/vnd.openxmlformats-officedocument.wordprocessingml.document':
      return extractDocx(buffer);
    case 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet':
      return extractXlsx(buffer);
    default:
      throw new CurriculumExtractionError(`Unsupported mimetype for extraction: ${mimeType}`);
  }
}

function isExtractionEmpty(extracted) {
  if (extracted.format === 'xlsx') {
    return !extracted.sheets.some((sheet) =>
      sheet.rows.some((row) => row.some((cell) => String(cell ?? '').trim() !== ''))
    );
  }
  return !extracted.text || extracted.text.trim().length === 0;
}

module.exports = { extractCurriculumContent, isExtractionEmpty, CurriculumExtractionError };
