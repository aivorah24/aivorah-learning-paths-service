// CISCE download/validate + extract stages, on synthetic fixture PDFs.
const fs = require('fs');
const os = require('os');
const path = require('path');
const { validatePdf, downloadSource, extractPdf } = require('../../services/cisce/pdf');
const { createHttp } = require('../../services/cisce/http');
const { withDefaults } = require('../../services/cisce/registry');
const { sha256 } = require('../../services/cisce/ids');
const { fakeFetch, fixture, FIXTURES } = require('../helpers/cisceMocks');

const http = (routes) => createHttp({ fetchImpl: fakeFetch(routes), sleep: async () => {}, minIntervalMs: 0 });
const URL_ = 'https://cisce.org/wp-content/uploads/2026/01/99.-Testology.pdf';
let cacheDir;
beforeEach(() => { cacheDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cisce-test-')); });
afterEach(() => fs.rmSync(cacheDir, { recursive: true, force: true }));

describe('validatePdf', () => {
  test.each([
    ['empty file', Buffer.alloc(0), 'EMPTY'],
    ['404 HTML page', fixture('not-a-pdf.html'), 'HTML_NOT_PDF'],
    ['no %PDF header', Buffer.from('hello world'), 'NO_PDF_HEADER'],
    ['%PDF header but broken body', fixture('corrupt.pdf'), 'UNPARSEABLE'],
  ])('rejects %s', async (_name, buf, reason) => {
    expect(await validatePdf(buf)).toMatchObject({ ok: false, reason });
  });

  test('accepts a real PDF and reports its page count', async () => {
    expect(await validatePdf(fixture('syllabus-text.pdf'))).toEqual({ ok: true, pageCount: 2 });
  });
});

describe('downloadSource', () => {
  test('records status, final URL, content type, sha256, bytes and page count; caches the PDF locally', async () => {
    const body = fixture('syllabus-text.pdf');
    const src = withDefaults({ id: 's1', url: URL_ });
    const r = await downloadSource(src, http({ [URL_]: { body, contentType: 'application/pdf', finalUrl: `${URL_}?v=2` } }), { cacheDir, now: () => 'T' });
    expect(r.ok).toBe(true);
    expect(src).toMatchObject({
      link_status: 'VERIFIED', http_status: 200, final_url: `${URL_}?v=2`, content_type: 'application/pdf',
      sha256: sha256(body), bytes: body.length, page_count: 2, checked_at: 'T', checked_from: 'local-cli',
    });
    expect(fs.readFileSync(r.file).equals(body)).toBe(true);
  });

  test.each([
    [{ status: 404, body: '<!DOCTYPE html><html>nf</html>' }, 'DEAD'],
    [{ status: 403, body: 'Forbidden' }, 'UNREACHABLE'],
    [{ status: 200, body: '<!DOCTYPE html><html>soft 404</html>', contentType: 'text/html' }, 'INVALID_PDF'],
    [{ status: 200, body: '', contentType: 'application/pdf' }, 'INVALID_PDF'],
  ])('%j → %s, nothing cached', async (route, status) => {
    const src = withDefaults({ id: 's1', url: URL_ });
    const r = await downloadSource(src, http({ [URL_]: route }), { cacheDir });
    expect(r.ok).toBe(false);
    expect(src.link_status).toBe(status);
    expect(fs.existsSync(path.join(cacheDir, 'sources'))).toBe(false);
  });
});

describe('extractPdf', () => {
  test('text pages use the text layer; OCR runs only on the scanned page', async () => {
    const ocr = jest.fn().mockResolvedValue('OCR TEXT FROM IMAGE');
    const ex = await extractPdf(path.join(FIXTURES, 'scanned-mixed.pdf'), { ocr });
    expect(ocr).toHaveBeenCalledTimes(1);
    expect(ocr).toHaveBeenCalledWith(expect.any(String), 2);
    expect(ex.pages.map((p) => p.method)).toEqual(['text', 'ocr']);
    expect(ex).toMatchObject({ pageCount: 2, textPages: 1, ocrPages: 1, emptyPages: 0 });
  });

  test('without an OCR engine a scanned page stays empty and is warned about, never filled', async () => {
    const ex = await extractPdf(path.join(FIXTURES, 'scanned-mixed.pdf'), { ocr: null });
    expect(ex.pages[1]).toMatchObject({ method: 'none', text: '' });
    expect(ex.emptyPages).toBe(1);
    expect(ex.warnings[0]).toMatch(/no OCR engine/);
  });

  test('a fully text PDF never calls OCR', async () => {
    const ocr = jest.fn();
    const ex = await extractPdf(path.join(FIXTURES, 'syllabus-text.pdf'), { ocr });
    expect(ocr).not.toHaveBeenCalled();
    expect(ex.textPages).toBe(2);
    expect(ex.pages[0].text).toMatch(/CLASS IX/);
  });
});
