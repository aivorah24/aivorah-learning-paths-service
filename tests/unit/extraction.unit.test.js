jest.mock('pdf-parse');
jest.mock('mammoth');

const pdfParse = require('pdf-parse');
const mammoth = require('mammoth');
const XLSX = require('xlsx');
const {
  extractCurriculumContent,
  isExtractionEmpty,
  CurriculumExtractionError,
} = require('../../services/curriculumUpload/extraction');

const PDF_MIME = 'application/pdf';
const DOCX_MIME = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
const XLSX_MIME = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';

function realXlsxBuffer(rows) {
  const sheet = XLSX.utils.aoa_to_sheet(rows);
  const workbook = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(workbook, sheet, 'Sheet1');
  return XLSX.write(workbook, { type: 'buffer', bookType: 'xlsx' });
}

describe('extractCurriculumContent', () => {
  beforeEach(() => jest.clearAllMocks());

  test('extracts text from a valid PDF', async () => {
    pdfParse.mockResolvedValueOnce({ text: 'Chapter 1: Numbers', numpages: 3 });
    const result = await extractCurriculumContent(Buffer.from('x'), PDF_MIME);
    expect(result).toEqual({ format: 'pdf', text: 'Chapter 1: Numbers', pageCount: 3 });
  });

  test('wraps a PDF parser failure in CurriculumExtractionError', async () => {
    // Both the default reader and the fallback one fail.
    pdfParse.mockRejectedValueOnce(new Error('bad xref table')).mockRejectedValueOnce(new Error('still bad'));
    await expect(extractCurriculumContent(Buffer.from('x'), PDF_MIME)).rejects.toThrow(/Failed to parse PDF: bad xref table/);
  });

  test('a PDF the default reader rejects is retried with the newer bundled reader', async () => {
    pdfParse.mockRejectedValueOnce(new Error('bad XRef entry')).mockResolvedValueOnce({ text: 'Unit 1: Resources', numpages: 1 });
    const result = await extractCurriculumContent(Buffer.from('x'), PDF_MIME);
    expect(result).toEqual({ format: 'pdf', text: 'Unit 1: Resources', pageCount: 1 });
    expect(pdfParse).toHaveBeenLastCalledWith(expect.any(Buffer), expect.objectContaining({ version: 'v2.0.550' }));
  });

  test('extracts text from a valid DOCX', async () => {
    mammoth.extractRawText.mockResolvedValueOnce({ value: 'Unit 1: Fractions' });
    const result = await extractCurriculumContent(Buffer.from('x'), DOCX_MIME);
    expect(result).toEqual({ format: 'docx', text: 'Unit 1: Fractions' });
  });

  test('wraps a DOCX parser failure in CurriculumExtractionError', async () => {
    mammoth.extractRawText.mockRejectedValueOnce(new Error('not a valid zip'));
    await expect(extractCurriculumContent(Buffer.from('x'), DOCX_MIME)).rejects.toThrow(CurriculumExtractionError);
  });

  test('extracts structured rows from a valid XLSX', async () => {
    const buffer = realXlsxBuffer([['Subject', 'Chapter'], ['Maths', 'Fractions']]);
    const result = await extractCurriculumContent(buffer, XLSX_MIME);
    expect(result.format).toBe('xlsx');
    expect(result.sheets[0].name).toBe('Sheet1');
    expect(result.sheets[0].rows).toEqual([['Subject', 'Chapter'], ['Maths', 'Fractions']]);
  });

  test('wraps a malformed XLSX in CurriculumExtractionError', async () => {
    const garbage = Buffer.from([0x50, 0x4b, 0x03, 0x04, 0x00, 0x01, 0x02, 0x03, 0x04, 0x05, 0x06, 0x07]);
    await expect(extractCurriculumContent(garbage, XLSX_MIME)).rejects.toThrow(CurriculumExtractionError);
  });

  test('rejects an unsupported mimetype', async () => {
    await expect(extractCurriculumContent(Buffer.from('x'), 'image/png')).rejects.toThrow(CurriculumExtractionError);
  });
});

describe('isExtractionEmpty', () => {
  test('true for blank PDF/DOCX text', () => {
    expect(isExtractionEmpty({ format: 'pdf', text: '' })).toBe(true);
    expect(isExtractionEmpty({ format: 'pdf', text: '   ' })).toBe(true);
  });

  test('false for non-blank text', () => {
    expect(isExtractionEmpty({ format: 'docx', text: 'Unit 1' })).toBe(false);
  });

  test('true for an XLSX with only blank cells', () => {
    expect(isExtractionEmpty({ format: 'xlsx', sheets: [{ name: 'S1', rows: [['', ''], [null, undefined]] }] })).toBe(true);
  });

  test('false for an XLSX with at least one non-blank cell', () => {
    expect(isExtractionEmpty({ format: 'xlsx', sheets: [{ name: 'S1', rows: [['', 'Chapter 1']] }] })).toBe(false);
  });
});
