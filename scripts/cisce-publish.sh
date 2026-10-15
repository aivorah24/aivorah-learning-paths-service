#!/usr/bin/env bash
# One command: save the official CISCE syllabus to Dev (retrying network drops),
# then copy it to the Test DB the live app uses.
#   bash scripts/cisce-publish.sh
set -u
cd "$(dirname "$0")/.."
mkdir -p .cisce-cache/logs
LOG=".cisce-cache/logs/publish-$(date +%Y%m%d-%H%M).log"

for attempt in 1 2 3 4 5; do
  echo "== Dev save, attempt $attempt (log: $LOG)"
  node scripts/cisce-ingest.cjs run --resume --stage normalise,validate,persist,index,coverage --log-file "$LOG" > /dev/null 2>&1
  if [ "$(tail -n 50 "$LOG" | grep -c ' 0 failed')" -gt 0 ]; then echo "   Dev save OK"; break; fi
  echo "   some sources failed — retrying in 20s"
  : > "$LOG"
  sleep 20
done

if [ "$(tail -n 50 "$LOG" | grep -c ' 0 failed')" -eq 0 ]; then
  echo "Dev save still failing after 5 attempts — see $LOG. Not copying to Test."
  exit 1
fi

echo "== Copying Dev → Test"
node scripts/cisce-copy-to-test.cjs
