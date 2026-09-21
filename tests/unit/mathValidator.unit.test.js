const { evaluateExpression, verifyCalculationString, verifyWorkedExample } = require('../../services/curriculumUpload/mathValidator');

describe('evaluateExpression', () => {
  test('basic arithmetic with precedence', () => {
    expect(evaluateExpression('2 + 3 * 4')).toBe(14);
  });
  test('parentheses', () => {
    expect(evaluateExpression('(2 + 3) * 4')).toBe(20);
  });
  test('decimals and unary minus', () => {
    expect(evaluateExpression('-2.5 + 5')).toBeCloseTo(2.5);
  });
  test('throws on garbage input', () => {
    expect(() => evaluateExpression('2 + x')).toThrow();
  });
});

describe('verifyCalculationString', () => {
  test('valid equality passes', () => {
    expect(verifyCalculationString('12 + 8 = 20')).toMatchObject({ checked: true, valid: true });
  });
  test('incorrect equality fails', () => {
    expect(verifyCalculationString('12 + 8 = 21')).toMatchObject({ checked: true, valid: false });
  });
  test('non-equality expression is unverifiable, not a failure', () => {
    expect(verifyCalculationString('12 + 8')).toMatchObject({ checked: false, valid: true });
  });
  test('non-numeric (algebraic/fraction-word) calculation is unverifiable, not a failure', () => {
    expect(verifyCalculationString('one quarter plus one half = three quarters')).toMatchObject({ checked: false, valid: true });
  });
  test('empty calculation is unverifiable', () => {
    expect(verifyCalculationString('')).toEqual({ checked: false, valid: true });
  });
});

describe('verifyWorkedExample', () => {
  test('all correct calculations pass', () => {
    const block = { steps: [{ step_number: 1, explanation: 'a', calculation: '2 + 2 = 4' }, { step_number: 2, explanation: 'b', calculation: '4 * 3 = 12' }] };
    const result = verifyWorkedExample(block);
    expect(result.valid).toBe(true);
    expect(result.checked).toBe(true);
    expect(result.failures).toEqual([]);
  });

  test('one wrong calculation fails with the offending step reported', () => {
    const block = { steps: [{ step_number: 1, explanation: 'a', calculation: '2 + 2 = 5' }] };
    const result = verifyWorkedExample(block);
    expect(result.valid).toBe(false);
    expect(result.failures).toHaveLength(1);
    expect(result.failures[0].step_number).toBe(1);
  });

  test('legacy {action, why} steps with no calculation field are skipped, not failed', () => {
    const block = { steps: [{ step: 1, action: 'do it', why: 'because' }] };
    const result = verifyWorkedExample(block);
    expect(result.valid).toBe(true);
    expect(result.checked).toBe(false);
  });

  test('no steps array is treated as trivially valid', () => {
    expect(verifyWorkedExample({})).toEqual({ valid: true, checked: false, failures: [] });
  });
});
