const { validateEnrichment } = require('../../services/curriculum/blockSchema');

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
