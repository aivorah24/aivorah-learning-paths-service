const { retrieveGroundingContext } = require('../../services/curriculumUpload/groundedContent');

const realFetch = global.fetch;
afterEach(() => { global.fetch = realFetch; jest.clearAllMocks(); });

function jsonResponse(body, ok = true) {
  return Promise.resolve({ ok, json: () => Promise.resolve(body) });
}

describe('retrieveGroundingContext', () => {
  test('returns the retrieval result for a high-confidence topic match', async () => {
    global.fetch = jest.fn().mockResolvedValue(jsonResponse({
      context: 'real ncert text', meta: { selected: 1 }, sources: [{ topic: 'Fractions', score: 0.63 }],
    }));

    const result = await retrieveGroundingContext({ curriculum: 'CBSE', grade: '6', subject: 'Mathematics', topic: 'Whole Numbers', subtopics: ['Number line'] });

    expect(result.context).toBe('real ncert text');
    const [url, options] = global.fetch.mock.calls[0];
    expect(url).toContain('/curriculum-context');
    expect(JSON.parse(options.body)).toEqual({
      question: 'Whole Numbers, Number line', curriculum: 'CBSE', grade: '6', subject: 'Mathematics', topic: 'Whole Numbers',
    });
  });

  test('returns null when retrieval finds nothing (meta.selected is 0)', async () => {
    global.fetch = jest.fn().mockResolvedValue(jsonResponse({ context: '', meta: { selected: 0 }, sources: [] }));
    const result = await retrieveGroundingContext({ curriculum: 'CBSE', grade: '6', subject: 'Mathematics', topic: 'Whole Numbers' });
    expect(result).toBeNull();
  });

  test('rejects a merely chapter-adjacent match below the score threshold — real data showed 0.32-0.38 for off-topic chapters', async () => {
    global.fetch = jest.fn().mockResolvedValue(jsonResponse({
      context: 'a loosely related chapter blurb', meta: { selected: 4 }, sources: [{ topic: 'The Other Side of Zero', score: 0.35 }],
    }));
    const result = await retrieveGroundingContext({ curriculum: 'CBSE', grade: '6', subject: 'Mathematics', topic: 'Whole Numbers' });
    expect(result).toBeNull();
  });

  test('accepts a match right at the threshold', async () => {
    global.fetch = jest.fn().mockResolvedValue(jsonResponse({
      context: 'text', meta: { selected: 1 }, sources: [{ topic: 'X', score: 0.4 }],
    }));
    const result = await retrieveGroundingContext({ curriculum: 'CBSE', grade: '6', subject: 'Mathematics', topic: 'X' });
    expect(result).not.toBeNull();
  });

  test('defaults missing curriculum to NCERT, not CBSE — the only curriculum actually ingested into Qdrant', async () => {
    global.fetch = jest.fn().mockResolvedValue(jsonResponse({
      context: 'real ncert text', meta: { selected: 1 }, sources: [{ topic: 'Whole Numbers', score: 0.57 }],
    }));
    const result = await retrieveGroundingContext({ grade: '6', subject: 'Mathematics', topic: 'Whole Numbers' });
    expect(result).not.toBeNull();
    const [, options] = global.fetch.mock.calls[0];
    expect(JSON.parse(options.body).curriculum).toBe('NCERT');
  });

  test('returns null without calling fetch when grade or subject is missing', async () => {
    global.fetch = jest.fn();
    const result = await retrieveGroundingContext({ curriculum: 'CBSE', topic: 'Whole Numbers' });
    expect(result).toBeNull();
    expect(global.fetch).not.toHaveBeenCalled();
  });

  test('returns null on a non-ok response rather than throwing', async () => {
    global.fetch = jest.fn().mockResolvedValue(jsonResponse({ error: 'boom' }, false));
    const result = await retrieveGroundingContext({ curriculum: 'CBSE', grade: '6', subject: 'Mathematics', topic: 'Whole Numbers' });
    expect(result).toBeNull();
  });

  test('retries once after a cold-start network failure, then returns null if it keeps failing', async () => {
    global.fetch = jest.fn().mockRejectedValue(new Error('network down'));
    const result = await retrieveGroundingContext({ curriculum: 'CBSE', grade: '6', subject: 'Mathematics', topic: 'Whole Numbers' });
    expect(result).toBeNull();
    expect(global.fetch).toHaveBeenCalledTimes(2);
  }, 8000);

  test('passes through images from the ai-coach-service response (rag.js buildImages() output)', async () => {
    global.fetch = jest.fn().mockResolvedValue(jsonResponse({
      context: 'real ncert text', meta: { selected: 1 }, sources: [{ topic: 'Whole Numbers', score: 0.57 }],
      images: [{ url: 'https://cdn/img.png', caption: 'A number line', subject: 'Mathematics', grade: '6', topic: 'Whole Numbers' }],
    }));
    const result = await retrieveGroundingContext({ curriculum: 'CBSE', grade: '6', subject: 'Mathematics', topic: 'Whole Numbers' });
    expect(result.images).toEqual([{ url: 'https://cdn/img.png', caption: 'A number line', subject: 'Mathematics', grade: '6', topic: 'Whole Numbers' }]);
  });

  test('defaults images to an empty array when the response has none', async () => {
    global.fetch = jest.fn().mockResolvedValue(jsonResponse({
      context: 'real ncert text', meta: { selected: 1 }, sources: [{ topic: 'Whole Numbers', score: 0.57 }],
    }));
    const result = await retrieveGroundingContext({ curriculum: 'CBSE', grade: '6', subject: 'Mathematics', topic: 'Whole Numbers' });
    expect(result.images).toEqual([]);
  });

  test('recovers on retry if the first attempt fails but the second succeeds — the actual cold-start case', async () => {
    global.fetch = jest.fn()
      .mockRejectedValueOnce(new Error('network down'))
      .mockResolvedValueOnce(jsonResponse({
        context: 'real ncert text', meta: { selected: 1 }, sources: [{ topic: 'Whole Numbers', score: 0.57 }],
      }));
    const result = await retrieveGroundingContext({ curriculum: 'CBSE', grade: '6', subject: 'Mathematics', topic: 'Whole Numbers' });
    expect(result).not.toBeNull();
    expect(global.fetch).toHaveBeenCalledTimes(2);
  }, 8000);
});
