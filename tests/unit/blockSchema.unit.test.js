const { validateEnrichment, validateBlock } = require('../../services/curriculum/blockSchema');

describe('validateEnrichment', () => {
  test('a real, well-formed theory payload is valid', () => {
    const result = validateEnrichment({
      whatYoullLearn: ['What relevant information means', 'Why it matters for decisions'],
      blocks: [
        { type: 'explanation', text: 'Information helps users make decisions.' },
        { type: 'key_terms', items: [{ term: 'Relevance', definition: 'Capable of making a difference to a decision.' }] },
      ],
    });
    expect(result.valid).toBe(true);
    expect(result.blocks).toHaveLength(2);
    expect(result.errors).toHaveLength(0);
  });

  test('a real worked_example with real steps is valid', () => {
    const result = validateEnrichment({
      whatYoullLearn: ['How to solve a quadratic'],
      blocks: [{
        type: 'worked_example',
        problem: 'Solve x^2 - 5x + 6 = 0',
        concept: 'Factoring',
        steps: [
          { step: 1, action: 'Factor the expression', equation: '(x-2)(x-3)=0', why: 'Product of two terms is zero only if one term is zero.' },
        ],
        finalAnswer: 'x = 2 or x = 3',
      }],
    });
    expect(result.valid).toBe(true);
  });

  // Regression: this is the exact defect the pilot was built to fix — a
  // maths worked example must never collapse to just the final answer.
  test('a worked_example missing steps is rejected, not silently accepted', () => {
    const result = validateEnrichment({
      whatYoullLearn: ['x'],
      blocks: [{ type: 'worked_example', problem: 'Solve x', finalAnswer: '3' }],
    });
    expect(result.valid).toBe(false);
    expect(result.blocks).toHaveLength(0);
  });

  test('missing whatYoullLearn is invalid even with good blocks', () => {
    const result = validateEnrichment({ blocks: [{ type: 'explanation', text: 'x' }] });
    expect(result.valid).toBe(false);
  });

  test('an unknown block type is dropped, not fatal to the whole payload', () => {
    const result = validateEnrichment({
      whatYoullLearn: ['x'],
      blocks: [
        { type: 'explanation', text: 'A real explanation.' },
        { type: 'totally_made_up_type', text: 'x' },
      ],
    });
    expect(result.valid).toBe(true);
    expect(result.blocks).toHaveLength(1);
    expect(result.errors.some((e) => e.includes('unknown type'))).toBe(true);
  });

  test('a poem_line block requires both the original text and the explanation, never just one', () => {
    const missingSource = validateEnrichment({
      whatYoullLearn: ['x'],
      blocks: [{ type: 'poem_line', explanation: 'A simple retelling.' }],
    });
    expect(missingSource.valid).toBe(false);

    const complete = validateEnrichment({
      whatYoullLearn: ['x'],
      blocks: [{ type: 'poem_line', sourceText: 'मैं बीज बोता हूँ', explanation: 'The speaker plants a seed.' }],
    });
    expect(complete.valid).toBe(true);
    expect(complete.blocks[0].sourceText).toBe('मैं बीज बोता हूँ');
  });

  test('a totally empty blocks array is invalid — never store a lesson with nothing to show', () => {
    const result = validateEnrichment({ whatYoullLearn: ['x'], blocks: [] });
    expect(result.valid).toBe(false);
  });

  test('null/non-object input never throws', () => {
    expect(validateEnrichment(null).valid).toBe(false);
    expect(validateEnrichment('a string').valid).toBe(false);
    expect(validateEnrichment(undefined).valid).toBe(false);
  });
});

describe('validateBlock', () => {
  test('accepts a well-formed worked_example block', () => {
    expect(validateBlock({
      type: 'worked_example',
      problem: '1/4 + 1/2 = ?',
      concept: 'Adding unlike fractions',
      steps: [{ step: 1, action: 'Convert to a common denominator', why: 'fractions need the same denominator to add' }],
      finalAnswer: '3/4',
    })).toBe(true);
  });

  test('rejects a worked_example missing its steps', () => {
    expect(validateBlock({ type: 'worked_example', problem: 'x', finalAnswer: '3' })).toBe(false);
  });

  test('rejects an unknown block type', () => {
    expect(validateBlock({ type: 'not_a_real_type', text: 'x' })).toBe(false);
  });

  test('rejects null, non-object and typeless input without throwing', () => {
    expect(validateBlock(null)).toBe(false);
    expect(validateBlock('x')).toBe(false);
    expect(validateBlock({})).toBe(false);
  });

  test('accepts the newer worked_example step_number/explanation/calculation shape', () => {
    expect(validateBlock({
      type: 'worked_example',
      problem: '12 + 8 = ?',
      steps: [{ step_number: 1, explanation: 'Add the numbers', calculation: '12 + 8 = 20' }],
      finalAnswer: '20',
    })).toBe(true);
  });

  test('rejects a worked_example step missing both shapes', () => {
    expect(validateBlock({
      type: 'worked_example',
      problem: 'x',
      steps: [{ step_number: 1 }],
      finalAnswer: 'y',
    })).toBe(false);
  });

  test('accepts a valid image block', () => {
    expect(validateBlock({ type: 'image', url: 'https://cdn/x.png', caption: 'A diagram' })).toBe(true);
  });
  test('rejects an image block missing url or caption', () => {
    expect(validateBlock({ type: 'image', url: 'https://cdn/x.png' })).toBe(false);
    expect(validateBlock({ type: 'image', caption: 'A diagram' })).toBe(false);
  });

  test('accepts a valid timeline block', () => {
    expect(validateBlock({
      type: 'timeline',
      title: 'Freedom Struggle',
      events: [{ date: '1857', description: 'Revolt of 1857' }],
    })).toBe(true);
  });
  test('rejects a timeline block with no events', () => {
    expect(validateBlock({ type: 'timeline', events: [] })).toBe(false);
  });

  test('accepts a valid cause_and_effect block', () => {
    expect(validateBlock({
      type: 'cause_and_effect',
      items: [{ cause: 'Deforestation', effect: 'Soil erosion' }],
    })).toBe(true);
  });
  test('rejects a cause_and_effect item missing cause or effect', () => {
    expect(validateBlock({ type: 'cause_and_effect', items: [{ cause: 'Deforestation' }] })).toBe(false);
  });

  test('accepts a valid case_study block', () => {
    expect(validateBlock({ type: 'case_study', title: 'The Green Revolution', text: 'Details...' })).toBe(true);
  });
  test('rejects a case_study missing text', () => {
    expect(validateBlock({ type: 'case_study', title: 'x' })).toBe(false);
  });

  test('accepts a valid table block', () => {
    expect(validateBlock({
      type: 'table',
      caption: 'Place Value Chart',
      headers: ['Period', 'Digit'],
      rows: [['Thousands', '9'], ['Units', '3']],
    })).toBe(true);
  });
  test('rejects a table block with no rows', () => {
    expect(validateBlock({ type: 'table', headers: ['Period', 'Digit'], rows: [] })).toBe(false);
  });
  test('rejects a table block whose row length does not match headers', () => {
    expect(validateBlock({
      type: 'table',
      headers: ['Period', 'Digit'],
      rows: [['Thousands']],
    })).toBe(false);
  });
});
