// Aligns what a child said (ASR words) with the known passage, word by word.

function splitWords(text) {
  return (text || '').split(/[-—–\s]+/).filter(Boolean);
}

function norm(w) {
  return (w || '').toLowerCase().replace(/[^a-z0-9']/g, '').replace(/^'+|'+$/g, '');
}

function getStem(w) {
  if (!w) return '';
  let s = w.replace(/our($|s|ed|ing)/, 'or$1')
    .replace(/ise($|s|d|ing)/, 'ize$1')
    .replace(/tre($|s)/, 'ter$1')
    .replace(/isation($|s)/, 'ization$1')
    .replace(/aeroplane/, 'airplane')
    .replace(/grey/, 'gray');
  s = s.replace(/ied$/, 'y')
    .replace(/ies$/, 'y')
    .replace(/(.)\1(ed|ing)$/, '$1');
  if (w.length > 4 && !/(?:thing|ning|ling|ring|king|wing|spring|bring)$/.test(w)) {
    s = s.replace(/(?:es|s|ed|ing)$/, '');
  } else if (w.length > 3) {
    s = s.replace(/(?:es|s)$/, '');
  }
  return s;
}

const EQUIV_MAP = {
  mr: ['mister'], mrs: ['missus', 'missis'], dr: ['doctor'], st: ['street', 'saint'],
  vs: ['versus'], etc: ['etcetera'], and: ['&'],
  hear: ['here'], here: ['hear'],
  there: ['their', 'theyre'], their: ['there', 'theyre'], theyre: ['there', 'their'],
  to: ['too', 'two'], too: ['to', 'two'], two: ['to', 'too'],
  for: ['four'], four: ['for'],
  no: ['know'], know: ['no'],
  right: ['write'], write: ['right'],
  by: ['buy'], buy: ['by'],
  one: ['won'], won: ['one'],
  cant: ['cannot'], cannot: ['cant'],
  dont: ['do not'], wont: ['will not'],
  10: ['ten'], 100: ['hundred', 'one hundred'], 1000: ['thousand', 'one thousand'],
  '1st': ['first'], '2nd': ['second'], '3rd': ['third'], '4th': ['fourth'], '5th': ['fifth'],
};

function isEquivalent(spoken, expected) {
  if (!spoken || !expected) return false;
  if (spoken === expected) return true;
  if (EQUIV_MAP[expected]?.includes(spoken)) return true;
  if (EQUIV_MAP[spoken]?.includes(expected)) return true;
  return false;
}

function levenshtein(a, b) {
  const m = a.length, n = b.length;
  if (m === 0) return n;
  if (n === 0) return m;
  const d = Array.from({ length: m + 1 }, (_, i) =>
    Array.from({ length: n + 1 }, (_, j) => (i === 0 ? j : j === 0 ? i : 0)));
  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      d[i][j] = a[i - 1] === b[j - 1] ? d[i - 1][j - 1] : 1 + Math.min(d[i - 1][j], d[i][j - 1], d[i - 1][j - 1]);
    }
  }
  return d[m][n];
}

function fuzzy(spoken, expected) {
  if (!spoken || !expected) return false;
  if (spoken === expected) return true;
  if (isEquivalent(spoken, expected)) return true;

  const sStem = getStem(spoken);
  const eStem = getStem(expected);
  if (sStem.length >= 3 && sStem === eStem) return true;
  if (expected.length <= 5) return false;
  if (Math.abs(spoken.length - expected.length) > 2) return false;
  if (spoken.slice(0, 3) !== expected.slice(0, 3) && sStem.slice(0, 3) !== eStem.slice(0, 3)) return false;

  const maxDist = expected.length >= 10 ? 2 : 1;
  return levenshtein(spoken, expected) <= maxDist || (sStem.length >= 5 && levenshtein(sStem, eStem) <= maxDist);
}

// Edit-distance alignment with 1-to-2 ("everyday" = "every day") and 2-to-1 ("can not" = "cannot") steps.
function matchWordsToPassage(spokenWords, passageWords, isLive = false) {
  const spoken = (spokenWords || []).map(norm).filter(Boolean);
  const passage = (passageWords || []).map(norm).filter(Boolean);
  const N = passage.length;
  const M = spoken.length;

  if (N === 0) return { statuses: [], matchedUpTo: 0 };
  if (M === 0) {
    const statuses = new Array(N).fill(isLive ? 'pending' : 'skipped');
    if (isLive) statuses[0] = 'current';
    return { statuses, matchedUpTo: 0 };
  }

  const dp = Array.from({ length: M + 1 }, () => new Float32Array(N + 1));
  // 1 = match/substitute, 2 = skipped passage word, 3 = extra spoken word, 4 = 2-to-1, 5 = 1-to-2
  const trace = Array.from({ length: M + 1 }, () => new Uint8Array(N + 1));
  for (let i = 0; i <= M; i++) { dp[i][0] = i * 0.5; trace[i][0] = 3; }
  for (let j = 0; j <= N; j++) { dp[0][j] = j * 1.0; trace[0][j] = 2; }
  trace[0][0] = 0;

  for (let i = 1; i <= M; i++) {
    for (let j = 1; j <= N; j++) {
      const isMatch = fuzzy(spoken[i - 1], passage[j - 1]);
      let minCost = dp[i - 1][j - 1] + (isMatch ? 0 : 1.4);
      let step = 1;
      const costDel = dp[i][j - 1] + 1.0;
      const costIns = dp[i - 1][j] + 0.6;
      if (costDel < minCost) { minCost = costDel; step = 2; }
      if (costIns < minCost) { minCost = costIns; step = 3; }
      if (i >= 2 && fuzzy(spoken[i - 2] + spoken[i - 1], passage[j - 1]) && dp[i - 2][j - 1] < minCost) {
        minCost = dp[i - 2][j - 1]; step = 4;
      }
      if (j >= 2 && fuzzy(spoken[i - 1], passage[j - 2] + passage[j - 1]) && dp[i - 1][j - 2] < minCost) {
        minCost = dp[i - 1][j - 2]; step = 5;
      }
      dp[i][j] = minCost;
      trace[i][j] = step;
    }
  }

  const statuses = new Array(N).fill('pending');
  let i = M, j = N;
  let matchedUpTo = 0;
  while (i > 0 || j > 0) {
    const step = trace[i][j];
    if (step === 1) {
      j--; i--;
      statuses[j] = fuzzy(spoken[i], passage[j]) ? 'correct' : 'misread';
      if (matchedUpTo === 0) matchedUpTo = j + 1;
    } else if (step === 2) {
      j--;
      statuses[j] = 'skipped';
    } else if (step === 3) {
      i--;
    } else if (step === 4) {
      j--; i -= 2;
      statuses[j] = 'correct';
      if (matchedUpTo === 0) matchedUpTo = j + 1;
    } else if (step === 5) {
      j -= 2; i--;
      statuses[j] = 'correct';
      statuses[j + 1] = 'correct';
      if (matchedUpTo === 0) matchedUpTo = j + 2;
    } else {
      break;
    }
  }

  if (isLive) {
    for (let k = matchedUpTo; k < N; k++) statuses[k] = 'pending';
    if (matchedUpTo < N) statuses[matchedUpTo] = 'current';
  } else {
    for (let k = 0; k < N; k++) {
      if (statuses[k] === 'pending' || statuses[k] === 'current') statuses[k] = 'skipped';
    }
  }
  return { statuses, matchedUpTo };
}

module.exports = { splitWords, norm, getStem, isEquivalent, levenshtein, fuzzy, matchWordsToPassage };
