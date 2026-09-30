// Unit tests for services/curriculum/gradeFit.js — LLM judge mocked via fetch
// (judgeTopic now runs through services/llm/fallback.js's callWithFallback).
process.env.GROQ_API_KEY = 'test-groq-key';
const { resetFallbackState } = require('../../services/llm/fallback');

const mockCreate = jest.fn();
global.fetch = jest.fn(async (url, req) => {
  const body = JSON.parse(req.body);
  const result = await mockCreate({ model: body.model, messages: body.messages });
  const content = result?.choices?.[0]?.message?.content;
  return { ok: true, json: async () => ({ choices: [{ message: { content } }] }) };
});

const mockCheckRecipe = jest.fn(() => []);
jest.mock('../../services/curriculum/enrichment', () => ({ checkRecipe: (...args) => mockCheckRecipe(...args) }));

const { readabilityStats, ruleCheck, checkGradeFit } = require('../../services/curriculum/gradeFit');

function judgeReturns(jsonObj) {
  mockCreate.mockResolvedValueOnce({ choices: [{ message: { content: JSON.stringify(jsonObj) } }] });
}

const GOOD_SCORES = { ageAppropriate: 5, matchesChapter: 5, factuallySound: 5, clearExamples: 5 };
const SIMPLE_CONTENT = {
  blocks: [{ type: 'explanation', text: 'The sun is hot. It gives us light and warmth every day. Plants need this light to grow well and make their own food.' }],
  listenParts: [{ heading: 'Intro', text: 'The sun is a star. It is very hot.' }],
  practiceQuiz: [{ question: 'What gives us light?', options: ['Sun', 'Moon'], correct: 0 }],
};

beforeEach(() => {
  mockCreate.mockReset();
  mockCheckRecipe.mockReset().mockReturnValue([]);
  resetFallbackState();
});

describe('readabilityStats', () => {
  it('scores a short simple sentence at a low grade', () => {
    const stats = readabilityStats('The cat sat on the mat. It was warm.');
    expect(stats.grade).toBeLessThan(4);
    expect(stats.avgSentenceLen).toBeLessThan(10);
  });

  it('flags a Grade-12-level text for a Grade 6 student', () => {
    const advanced = 'The photosynthetic apparatus, comprising chlorophyll-laden thylakoid membranes embedded within chloroplast stroma, orchestrates the biochemical transformation of electromagnetic radiation into chemical potential energy through an intricately regulated series of photochemical and enzymatic reactions.';
    const { issues } = ruleCheck({ blocks: [{ type: 'explanation', text: advanced }] }, 6);
    expect(issues.length).toBeGreaterThan(0);
  });

  it('empty text scores grade 0 with no crash', () => {
    expect(readabilityStats('')).toEqual({ grade: 0, avgSentenceLen: 0, longWordPct: 0 });
  });
});

describe('ruleCheck — content-shape checks', () => {
  it('flags exponent notation for a Grade 6 student', () => {
    const { issues } = ruleCheck({ blocks: [{ type: 'explanation', text: 'A large number can be written as 4 x 10^4 using powers.' }] }, 6);
    expect(issues.some((i) => /exponent/i.test(i))).toBe(true);
  });

  it('does not flag exponent notation for a Grade 8 student', () => {
    const { issues } = ruleCheck({ blocks: [{ type: 'explanation', text: 'A large number can be written as 4 x 10^4 using powers of ten for the class to study together.' }] }, 8);
    expect(issues.some((i) => /exponent/i.test(i))).toBe(false);
  });

  it('flags a too-short explanation block', () => {
    const { issues } = ruleCheck({ blocks: [{ type: 'explanation', text: 'Fractions can be proper or improper.' }] }, 6);
    expect(issues.some((i) => /too short/i.test(i))).toBe(true);
  });

  it('flags a table with fewer than 2 columns', () => {
    const { issues } = ruleCheck({ blocks: [{ type: 'table', headers: ['Type'], rows: [['Proper']] }] }, 6);
    expect(issues.some((i) => /fewer than 2 columns/i.test(i))).toBe(true);
  });
});

describe('checkGradeFit', () => {
  it('passes when rules, recipe and judge all score well', async () => {
    judgeReturns({ learn: GOOD_SCORES, audio: GOOD_SCORES, practice: GOOD_SCORES, issues: [] });
    const result = await checkGradeFit({ topicTitle: 'The Sun', chapterTitle: 'Our Star', grade: 6, subject: 'Science', content: SIMPLE_CONTENT });
    expect(result.failed).toBe(false);
    expect(result.quality.judgeScores).toBeTruthy();
    expect(result.quality.issues).toEqual([]);
  });

  it('fails when the judge scores a section below 4', async () => {
    judgeReturns({ learn: { ...GOOD_SCORES, factuallySound: 2 }, audio: GOOD_SCORES, practice: GOOD_SCORES, issues: ['Learn block overstates a fact'] });
    const result = await checkGradeFit({ topicTitle: 'The Sun', chapterTitle: 'Our Star', grade: 6, subject: 'Science', content: SIMPLE_CONTENT });
    expect(result.failed).toBe(true);
    expect(result.quality.issues).toContain('Learn block overstates a fact');
  });

  it('a missing recipe part is advice for the teacher, not a blocking failure', async () => {
    mockCheckRecipe.mockReturnValue(['an activity block']);
    judgeReturns({ learn: GOOD_SCORES, audio: GOOD_SCORES, practice: GOOD_SCORES, issues: [] });
    const result = await checkGradeFit({ topicTitle: 'The Sun', chapterTitle: 'Our Star', grade: 6, subject: 'Science', content: SIMPLE_CONTENT });
    expect(result.failed).toBe(false);
    expect(result.quality.issues.some((i) => i.includes('an activity block'))).toBe(true);
  });

  it('style points (a short explanation) are advice; text far above the grade blocks', async () => {
    mockCheckRecipe.mockReturnValue([]);
    judgeReturns({ learn: GOOD_SCORES, audio: GOOD_SCORES, practice: GOOD_SCORES, issues: [] });
    const short = { blocks: [{ type: 'explanation', text: 'The Sun is a star.' }] };
    const advice = await checkGradeFit({ topicTitle: 'The Sun', chapterTitle: 'Our Star', grade: 6, subject: 'Science', content: short });
    expect(advice.failed).toBe(false);
    expect(advice.quality.issues.some((i) => /too short/.test(i))).toBe(true);

    judgeReturns({ learn: GOOD_SCORES, audio: GOOD_SCORES, practice: GOOD_SCORES, issues: [] });
    const dense = { blocks: [{ type: 'explanation', text: 'Thermonuclear electromagnetic radiation characteristically originates photospherically, simultaneously illuminating interplanetary environments, consequently establishing heliocentric gravitational equilibrium considerations internationally.' }] };
    const blocked = await checkGradeFit({ topicTitle: 'The Sun', chapterTitle: 'Our Star', grade: 6, subject: 'Science', content: dense });
    expect(blocked.failed).toBe(true);
  });

  it('the reviewer finding the content wrong still blocks the topic', async () => {
    mockCheckRecipe.mockReturnValue([]);
    judgeReturns({ learn: { ...GOOD_SCORES, factuallySound: 2 }, audio: GOOD_SCORES, practice: GOOD_SCORES, issues: ['Says the Sun is a planet'] });
    const result = await checkGradeFit({ topicTitle: 'The Sun', chapterTitle: 'Our Star', grade: 6, subject: 'Science', content: SIMPLE_CONTENT });
    expect(result.failed).toBe(true);
  });

  it('judge error leaves quality.judge null but does not fail the topic', async () => {
    mockCreate.mockRejectedValueOnce(new Error('rate limited'));
    const result = await checkGradeFit({ topicTitle: 'The Sun', chapterTitle: 'Our Star', grade: 6, subject: 'Science', content: SIMPLE_CONTENT });
    expect(result.quality.judgeScores).toBeNull();
    expect(result.failed).toBe(false);
  });
});
