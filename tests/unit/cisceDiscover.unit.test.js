// CISCE discover stage + polite HTTP client.
const { extractLinks, classifyPdf, parseYearPageUrl, discover } = require('../../services/cisce/discover');
const { createHttp } = require('../../services/cisce/http');
const { withDefaults } = require('../../services/cisce/registry');
const { BROWSER_UA } = require('../../services/cisce/constants');
const { fakeFetch } = require('../helpers/cisceMocks');

const noSleep = { sleep: async () => {}, minIntervalMs: 0 };

describe('extractLinks', () => {
  test('reads plain hrefs and Elementor data-ra-element-link JSON, resolved and de-duplicated', () => {
    const html = `
      <a href="/wp-content/uploads/2026/01/10.-Physics.pdf">Physics</a>
      <a href="https://cisce.org/wp-content/uploads/2026/01/10.-Physics.pdf#page=2">dup</a>
      <div data-ra-element-link="{&quot;type&quot;:&quot;custom&quot;,&quot;link&quot;:{&quot;url&quot;:&quot;https:\\/\\/cisce.org\\/wp-content\\/uploads\\/2026\\/01\\/11.-Chemistry.pdf&quot;,&quot;is_external&quot;:&quot;&quot;}}"></div>
      <div data-ra-element-link='not json https://cisce.org/wp-content/uploads/2026/01/12.-Biology.pdf'></div>`;
    const urls = extractLinks(html, 'https://cisce.org/regulations-and-syllabuses-icse-2028/').map((l) => l.url);
    expect(urls).toEqual([
      'https://cisce.org/wp-content/uploads/2026/01/10.-Physics.pdf',
      'https://cisce.org/wp-content/uploads/2026/01/11.-Chemistry.pdf',
      'https://cisce.org/wp-content/uploads/2026/01/12.-Biology.pdf',
    ]);
  });
});

describe('classifyPdf / parseYearPageUrl', () => {
  test('subject syllabus from the numbered file name, grades from the programme', () => {
    const c = classifyPdf('https://cisce.org/wp-content/uploads/2026/01/10.-Physics.pdf', { programme: 'ICSE', examYear: 2028, version: 'icse-2028' });
    expect(c).toMatchObject({ kind: 'SYLLABUS_PDF', subject: 'Physics', programme: 'ICSE', exam_year: 2028, grades: ['Class IX', 'Class X'] });
    expect(classifyPdf('https://cisce.org/a/1.-Regulations.pdf', { programme: 'ISC' }).kind).toBe('REGULATIONS_PDF');
    expect(classifyPdf('https://cisce.org/a/Amendments-ICSE-Year-2026-Regulations.pdf').kind).toBe('AMENDMENT_CIRCULAR');
    expect(classifyPdf('https://cisce.org/a/PrimaryCurriculum.pdf').kind).toBe('FRAMEWORK_PDF');
    expect(classifyPdf('https://cisce.org/a/5.-Physics.pdf', { programme: 'ISC' }).grades).toEqual(['Class XI', 'Class XII']);
  });

  test('year page slugs (inconsistent on cisce.org) parse to programme + year', () => {
    expect(parseYearPageUrl('https://cisce.org/regulations-and-syllabuses-icse-2028/')).toEqual({ programme: 'ICSE', examYear: 2028, revised: false });
    expect(parseYearPageUrl('https://cisce.org/regulations-and-syllabus-icse-2027/')).toEqual({ programme: 'ICSE', examYear: 2027, revised: false });
    expect(parseYearPageUrl('https://cisce.org/regulations-and-syllabus-isc-2026-revised/')).toEqual({ programme: 'ISC', examYear: 2026, revised: true });
    expect(parseYearPageUrl('https://cisce.org/icse-publications/')).toBeNull();
  });
});

describe('discover', () => {
  const INDEX = 'https://cisce.org/regulations-and-syllabuses-icse-2/';
  const Y28 = 'https://cisce.org/regulations-and-syllabuses-icse-2028/';
  const Y27 = 'https://cisce.org/regulations-and-syllabus-icse-2027/';
  const DEAD = 'https://cisce.org/wp-content/uploads/2025/02/1.-Regulations.pdf';

  function registry() {
    return {
      sources: [
        withDefaults({ id: 'icse-index', url: INDEX, kind: 'INDEX_PAGE', programme: 'ICSE' }),
        withDefaults({ id: 'dead-reg', url: DEAD, kind: 'REGULATIONS_PDF', programme: 'ICSE', link_status: 'DEAD', http_status: 404 }),
      ],
      awaiting_sources: [],
    };
  }

  test('index → year pages → PDFs; newest year is primary; dead and off-site links never added as live', async () => {
    const fetchImpl = fakeFetch({
      [INDEX]: { body: `<a href="${Y28}">ICSE 2028</a><a href="${Y27}">ICSE 2027</a><a href="/about/">About</a>`, contentType: 'text/html' },
      [Y28]: { body: '<a href="/wp-content/uploads/2026/01/10.-Physics.pdf">Physics</a><a href="https://evil.example/x.pdf">x</a>', contentType: 'text/html' },
      [Y27]: { body: `<a href="${DEAD}">Regulations</a><a href="/wp-content/uploads/2025/03/1.-Regulations.pdf">Regulations</a>`, contentType: 'text/html' },
    });
    const reg = registry();
    const { added } = await discover(reg, createHttp({ fetchImpl, ...noSleep }));
    const byUrl = Object.fromEntries(reg.sources.map((s) => [s.url, s]));
    expect(byUrl[Y28]).toMatchObject({ kind: 'YEAR_PAGE', exam_year: 2028, is_primary_version: true, link_status: 'VERIFIED', http_status: 200 });
    expect(byUrl[Y27].is_primary_version).toBe(false);
    expect(byUrl['https://cisce.org/wp-content/uploads/2026/01/10.-Physics.pdf']).toMatchObject({ subject: 'Physics', is_primary_version: true, discovered_from: 'icse-2028-page' });
    expect(byUrl['https://evil.example/x.pdf']).toBeUndefined();
    expect(byUrl[DEAD]).toMatchObject({ id: 'dead-reg', link_status: 'DEAD' });
    expect(added).toHaveLength(4);
  });

  test('a page that answers 403 is marked UNREACHABLE and yields nothing', async () => {
    const reg = registry();
    await discover(reg, createHttp({ fetchImpl: fakeFetch({ [INDEX]: { status: 403, body: 'Forbidden' } }), ...noSleep }));
    expect(reg.sources[0]).toMatchObject({ link_status: 'UNREACHABLE', http_status: 403 });
    expect(reg.sources).toHaveLength(2);
  });
});

describe('createHttp', () => {
  test('sends a browser User-Agent', async () => {
    const fetchImpl = fakeFetch({ 'https://cisce.org/': { body: 'ok' } });
    await createHttp({ fetchImpl, ...noSleep }).get('https://cisce.org/');
    expect(fetchImpl.requests[0].headers['User-Agent']).toBe(BROWSER_UA);
  });

  test('keeps request starts at least minIntervalMs apart, even with parallel callers', async () => {
    let clock = 0;
    const starts = [];
    const sleep = async (ms) => { clock += ms; };
    const fetchImpl = fakeFetch((url) => { starts.push(clock); return { body: url }; });
    const http = createHttp({ fetchImpl, sleep, now: () => clock, minIntervalMs: 1000 });
    await Promise.all(['a', 'b', 'c'].map((p) => http.get(`https://cisce.org/${p}`)));
    expect(starts).toEqual([0, 1000, 2000]);
  });

  test('retries 503 and network errors, but not 403/404', async () => {
    let n = 0;
    const flaky = fakeFetch(() => (++n < 3 ? { status: 503 } : { body: 'ok' }));
    expect((await createHttp({ fetchImpl: flaky, ...noSleep }).get('https://cisce.org/x')).status).toBe(200);
    expect(flaky.requests).toHaveLength(3);

    const forbidden = fakeFetch(() => ({ status: 403 }));
    expect((await createHttp({ fetchImpl: forbidden, ...noSleep }).get('https://cisce.org/x')).status).toBe(403);
    expect(forbidden.requests).toHaveLength(1);

    const down = fakeFetch(() => new Error('ECONNRESET'));
    const r = await createHttp({ fetchImpl: down, ...noSleep, retries: 1 }).get('https://cisce.org/x');
    expect(r).toMatchObject({ status: 0, ok: false, error: 'ECONNRESET' });
  });
});
