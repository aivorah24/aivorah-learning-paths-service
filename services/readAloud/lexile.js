const MIN_LEXILE = 100;
const MAX_LEXILE = 900;
const AUTO_STEP = 25;

function lexileToLevel(lexile) {
  if (lexile < 300) return 'easy';
  if (lexile <= 600) return 'medium';
  return 'hard';
}

function clampLexile(lexile) {
  return Math.max(MIN_LEXILE, Math.min(MAX_LEXILE, Math.round(lexile)));
}

// More than 5 errors steps the level down, fewer than 3 steps it up.
function autoAdjustment(errorCount) {
  if (errorCount > 5) return -AUTO_STEP;
  if (errorCount < 3) return AUTO_STEP;
  return 0;
}

module.exports = { lexileToLevel, clampLexile, autoAdjustment, MIN_LEXILE, MAX_LEXILE };
