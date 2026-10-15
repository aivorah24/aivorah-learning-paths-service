#!/usr/bin/env bash
# Unattended CISCE ingestion: runs the full pipeline with --resume, and
# re-runs it (after a pause) while some sources still fail, up to MAX_PASSES.
# Safe to stop at any time (Ctrl-C, closed laptop) — run it again to continue.
#
#   scripts/cisce-overnight.sh                 # full run, writes to Dev
#   scripts/cisce-overnight.sh --dry-run       # no Supabase/Qdrant writes
#   nohup scripts/cisce-overnight.sh > /dev/null 2>&1 &    # detached; follow with:
#   tail -f .cisce-cache/logs/overnight.log
#
# Any extra flags are passed through to scripts/cisce-ingest.cjs run.
set -u
cd "$(dirname "$0")/.."

MAX_PASSES="${MAX_PASSES:-4}"
PAUSE_SECONDS="${PAUSE_SECONDS:-300}"
LOG_DIR=".cisce-cache/logs"
LOG="$LOG_DIR/overnight.log"
mkdir -p "$LOG_DIR"

for pass in $(seq 1 "$MAX_PASSES"); do
  echo "[$(date -u +%FT%TZ)] overnight pass $pass/$MAX_PASSES" | tee -a "$LOG"
  node scripts/cisce-ingest.cjs run --resume --check-supplementary --log-file "$LOG" "$@"
  code=$?
  if [ "$code" -eq 0 ]; then
    echo "[$(date -u +%FT%TZ)] finished cleanly" | tee -a "$LOG"
    exit 0
  fi
  if [ "$code" -eq 1 ]; then
    echo "[$(date -u +%FT%TZ)] fatal error (see above) — not retrying" | tee -a "$LOG"
    exit 1
  fi
  echo "[$(date -u +%FT%TZ)] some sources failed; retrying failed ones in ${PAUSE_SECONDS}s" | tee -a "$LOG"
  sleep "$PAUSE_SECONDS"
done
echo "[$(date -u +%FT%TZ)] stopped after $MAX_PASSES passes with failures — check the coverage report" | tee -a "$LOG"
exit 2
