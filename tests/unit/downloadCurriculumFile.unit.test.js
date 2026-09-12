const { downloadCurriculumFile } = require('../../services/curriculumUpload/downloadCurriculumFile');

describe('downloadCurriculumFile', () => {
  const originalFetch = global.fetch;
  afterEach(() => { global.fetch = originalFetch; });

  test('returns a buffer for a successful fetch', async () => {
    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      arrayBuffer: async () => Buffer.from('file bytes'),
    });
    const buffer = await downloadCurriculumFile('https://cdn/x.pdf');
    expect(buffer).toEqual(Buffer.from('file bytes'));
  });

  test('throws when the response is not ok', async () => {
    global.fetch = jest.fn().mockResolvedValue({ ok: false, status: 404 });
    await expect(downloadCurriculumFile('https://cdn/missing.pdf')).rejects.toThrow(/404/);
  });

  test('propagates a network failure', async () => {
    global.fetch = jest.fn().mockRejectedValue(new Error('network down'));
    await expect(downloadCurriculumFile('https://cdn/x.pdf')).rejects.toThrow('network down');
  });
});
