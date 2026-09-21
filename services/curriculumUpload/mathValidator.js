// Deterministic arithmetic verification for Groq-generated worked_example
// blocks. No `mathjs`/eval — this project has no JSON-schema or math library
// anywhere (see blockSchema.js's own comment on that convention), and eval()
// on LLM-produced strings is a code-injection risk, so this is a small
// hand-rolled recursive-descent evaluator supporting +, -, *, /, (), unary
// minus, and decimals — enough to check simple arithmetic-verification
// "calculation" strings like "12 + 8 = 20" or "(3/4 + 1/2) = 1.25".

class ExpressionError extends Error {}

function tokenize(expr) {
  const tokens = [];
  const re = /\s*(\d+\.?\d*|\.\d+|[()+\-*/=]|.)/g;
  let m;
  while ((m = re.exec(expr))) {
    const t = m[1];
    if (t === undefined || t === '') continue;
    if (/^\s*$/.test(t)) continue;
    tokens.push(t);
  }
  return tokens;
}

// Recursive-descent parser: expr := term (('+'|'-') term)*
//                            term := factor (('*'|'/') factor)*
//                            factor := ['-'] (number | '(' expr ')')
function evaluateExpression(raw) {
  const tokens = tokenize(String(raw || '').trim());
  let pos = 0;

  function peek() { return tokens[pos]; }
  function next() { return tokens[pos++]; }

  function parseFactor() {
    const t = peek();
    if (t === '-') { next(); return -parseFactor(); }
    if (t === '(') {
      next();
      const v = parseExpr();
      if (next() !== ')') throw new ExpressionError('unbalanced parentheses');
      return v;
    }
    if (t !== undefined && /^\d/.test(t) || /^\.\d/.test(t || '')) {
      next();
      const n = Number(t);
      if (Number.isNaN(n)) throw new ExpressionError(`bad number "${t}"`);
      return n;
    }
    throw new ExpressionError(`unexpected token "${t}"`);
  }

  function parseTerm() {
    let v = parseFactor();
    while (peek() === '*' || peek() === '/') {
      const op = next();
      const rhs = parseFactor();
      v = op === '*' ? v * rhs : v / rhs;
    }
    return v;
  }

  function parseExpr() {
    let v = parseTerm();
    while (peek() === '+' || peek() === '-') {
      const op = next();
      const rhs = parseTerm();
      v = op === '+' ? v + rhs : v - rhs;
    }
    return v;
  }

  const result = parseExpr();
  if (pos !== tokens.length) throw new ExpressionError(`unexpected trailing token "${tokens[pos]}"`);
  return result;
}

const TOLERANCE = 1e-6;

// A "calculation" string may be a bare expression ("12 + 8") or an equality
// ("12 + 8 = 20"). Only equalities are actually checkable — a bare expression
// has nothing to verify against, so it's treated as unverifiable (not a
// failure) rather than silently assumed correct.
function verifyCalculationString(calc) {
  const str = String(calc || '').trim();
  if (!str) return { checked: false, valid: true };
  const parts = str.split('=');
  if (parts.length !== 2) return { checked: false, valid: true };

  try {
    const lhs = evaluateExpression(parts[0]);
    const rhs = evaluateExpression(parts[1]);
    const valid = Math.abs(lhs - rhs) <= TOLERANCE * Math.max(1, Math.abs(rhs));
    return { checked: true, valid, lhs, rhs };
  } catch (err) {
    // Non-numeric calculation (fractions written as words, algebraic
    // expressions with variables, etc.) — can't be deterministically
    // verified by this evaluator. Not a failure, just unverifiable.
    return { checked: false, valid: true, error: err.message };
  }
}

// Verifies every step of a worked_example block that carries the new
// {step_number, explanation, calculation} shape. Steps using the legacy
// {action, why} shape (no `calculation` field) are skipped — this function
// only ever adds verification, it never invalidates content the older shape
// already produces.
function verifyWorkedExample(block) {
  const steps = Array.isArray(block?.steps) ? block.steps : [];
  const failures = [];
  let anyChecked = false;

  steps.forEach((s, i) => {
    if (!s || typeof s.calculation !== 'string' || !s.calculation.trim()) return;
    const result = verifyCalculationString(s.calculation);
    if (result.checked) anyChecked = true;
    if (result.checked && !result.valid) {
      failures.push({ index: i, step_number: s.step_number, calculation: s.calculation, lhs: result.lhs, rhs: result.rhs });
    }
  });

  return { valid: failures.length === 0, checked: anyChecked, failures };
}

module.exports = { evaluateExpression, verifyCalculationString, verifyWorkedExample, ExpressionError };
