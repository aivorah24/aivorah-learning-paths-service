# NCERT Chapter Extraction Pipeline — Handoff

Context for whoever (human or another AI agent, e.g. Antigravity/Gemini CLI) runs and completes this. Written 2026-08-27 as part of fixing Aivorah's curriculum-content bugs (see `aivorah-frontend/BUGS_AND_FIXES.md`, Bug #6 and its follow-up).

## The problem, in one paragraph

The Learning Path screen shows NCERT chapter titles for Grades 1-12, all subjects. A full scan of all 154 `data/curricula/*-chapters.json` files in this repo (1465 chapters total) found: **681 chapters (46%) still show the literal placeholder `"Chapter N"`** — never had a real title extracted — and a smaller set had genuinely garbled titles (fixed separately, see Bug #6). The placeholder count is the dominant, user-visible bug ("Coming soon" / missing content across the Learning Path).

## Root cause

- The original monolith tool (`ai-mentor/server/scripts/extract-ncert-structure.cjs`) expects local PDF files at `data/ncert_books/grade<N>/<subject>/<code>.pdf`. **That directory doesn't exist on this machine, and the Supabase Storage bucket meant to hold these (`ncert-books`) is confirmed empty (checked live via the Storage API).** So the tool was never able to run to completion — that's very likely *why* 681 chapters were left as placeholders in the first place, not a logic bug in the extraction itself.
- Separately, the extraction regex only recognized **ALL-CAPS** chapter-title typesetting (older NCERT editions). The current (2026-revision) NCERT PDFs typeset titles in **Title Case**, sometimes wrapped across 2 lines with a colon (e.g. `"Orienting Yourself: The Use of Coordinates"`). The old regex simply never matches these — a second, independent cause of the same "stayed a placeholder" symptom.

## The fix already built (this session, do not redo)

New script: **`scripts/extract-ncert-from-web.cjs`** (in this repo — `aivorah-learning-paths-service`, NOT the monolith; the monolith must never be edited, see Guardrails below).

What it does, end to end:
1. Reads every `data/curricula/*-chapters.json` file in this repo.
2. For each chapter whose title is still a placeholder (or fails the garbage-title check — see below), downloads the real PDF directly from **`https://ncert.nic.in/textbook/pdf/<pdfFile>`** — confirmed live and working; `pdfFile` is already a field on every chapter record (e.g. `"iesc101.pdf"`), so no scraping or searching is needed, just a direct fetch.
3. Extracts the title from page 1 text using two strategies, tried in order:
   - **ALL-CAPS heading** — `titleFromPage1AllCaps()`, ported from the original monolith logic.
   - **Title-Case heading** — `titleFromPage1TitleCase()`, new. Takes the first 1-3 short lines at the top of page 1, stopping at a numbered subsection (`"1.1 Introduction"`), a sentence ending in `.`/`?` (body prose or an exercise instruction), a Roman-numeral/numbered list marker, or anything longer than 10 words.
4. Every candidate title is validated through `services/syllabus-map.js`'s existing `looksLikeRealTitle()` (the Bug #6 fix — rejects titles that are too short, have no vowel, are one giant run-together word, have a 5+ consonant run, are a self-duplicated fragment, or have 3+ repeated letters). A failing candidate is **left as the safe placeholder**, never written as garbage.
5. Uploads the downloaded PDF into the `ncert-books` Supabase Storage bucket at the chapter's existing `bookPath` — fixes the real root gap (empty bucket) as a side effect, so future re-runs and any "view textbook" UI have a real file to serve.
6. Writes the updated title/subtopics back into the JSON file, only if something actually changed.

**Confirmed working (small dry-run samples only — nothing committed yet):**
- Math/Science, newer editions: works correctly (verified: Grade 11 Math ch1 → `"Orienting Yourself: The Use of Coordinates"`, extracted live from the real downloaded PDF).
- Hindi: **correctly and safely fails every time.** The source PDFs are Devanagari script; this pdf-parse version extracts them as broken/mixed-encoded text (confirmed live against real downloads, not just old cached data). The garbage-check correctly rejects every single Hindi extraction attempt, so nothing corrupted gets written. **This is a known, accepted limitation — Hindi genuinely needs OCR-based extraction, a separate and bigger task, explicitly out of scope for this pipeline.** Don't try to "fix" Hindi within this script; leave those chapters as placeholders.
- English readers: mixed — some chapter PDFs open with an exercise/instruction page instead of a title page (e.g. `"I Complete the given word web."`), so page 1 genuinely has nothing to extract. The script correctly recognizes and skips these rather than guessing wrong.

## How to run it

```bash
cd aivorah-learning-paths-service

# 1. Dry run first, small sample — sanity-check before a full pass.
#    Nothing is written to disk or uploaded in --dry mode.
node scripts/extract-ncert-from-web.cjs --grades 9 --dry --limit 20

# 2. Once satisfied, run for real, one grade at a time (recommended, so a
#    problem is easy to isolate and re-run just that grade):
node scripts/extract-ncert-from-web.cjs --grades 1
node scripts/extract-ncert-from-web.cjs --grades 2
# ...through grade 12. Or all at once:
node scripts/extract-ncert-from-web.cjs
```

Flags: `--grades 1,2,3` (comma-separated, omit for all), `--dry` (no writes/uploads), `--limit N` (cap total chapters attempted, for testing).

It logs every chapter as:
- `[ok]` — title found and accepted, written.
- `[reject]` — something was extracted but failed the garbage check — left as safe placeholder.
- `[none]` — no heading found at all on page 1 — left as safe placeholder.
- `[skip]` — download or PDF-parse error — left as safe placeholder.

Plus a final summary line: `attempted / titled / rejectedAsGarbled / noHeadingFound / downloadFailed`.

**Nothing is ever silently corrupted** — worst case for any single chapter is "stays a placeholder," never a wrong or garbled title being shipped.

There's a 400ms delay between requests (politeness to ncert.nic.in) — a full 681-chapter run will take real wall-clock time; budget for it, don't expect it instant.

## Before you consider this done — verify these things

1. **Check the first few real (non-dry) uploads actually land in the `ncert-books` Supabase Storage bucket** — I built the upload call but only verified the download+extract logic end-to-end, not the Storage upload path. Check via the Supabase dashboard (Storage → `ncert-books`) or:
   ```bash
   curl -s -X POST "$SUPABASE_URL/storage/v1/object/list/ncert-books" \
     -H "apikey: $SUPABASE_SERVICE_KEY" -H "Authorization: Bearer $SUPABASE_SERVICE_KEY" \
     -H "Content-Type: application/json" -d '{"prefix":"grade9","limit":20}'
   ```
   should return real objects after a Grade 9 run, not `[]`.

2. **Re-run the full-scope scan afterward** to see the real before/after numbers (this exact script was used to produce the 46%/681 figure this session — rerun it after the pipeline to measure progress):
   ```js
   // scan every data/curricula/*.json file, count titles still matching
   // /^Chapter \d+$/i vs real titles — see aivorah-frontend/.scratch/
   // scan_curricula_titles2.cjs from this session for the exact reusable form.
   ```

3. **Spot-check a few chapters live** through the actual API once the frontend's `learningPathsServerUrl.ts` local-dev branch is active (already fixed this session — points `localhost:3006` → `localhost:3014` in dev):
   ```bash
   curl "http://localhost:3014/teacher/syllabus/current?grade=Grade%209&subject=Mathematics&curriculum=CBSE"
   ```

4. Run the existing test suite to confirm nothing regressed: `npx jest` in `aivorah-learning-paths-service` (should stay 65/65 or higher).

## Guardrails — do not violate these

- **Never edit anything inside `ai-mentor/server`** (the monolith) — not the routes, not the scripts, not even running its copy of the extraction tool. Everything for this pipeline lives in `aivorah-learning-paths-service` (this repo) only. If you find yourself needing something that only exists in the monolith, stop and flag it rather than reaching in.
- Don't try to "fix" Hindi extraction within this script — it's explicitly out of scope (needs OCR, a different tool entirely). Leaving Hindi chapters as `"Chapter N"` placeholders is the correct, safe outcome for now.
- Don't loosen `looksLikeRealTitle()`'s checks to force more chapters to get titled — a wrong/garbled title is worse than an honest placeholder. If a chapter keeps failing the check, that's the check doing its job.
- This is data-pipeline work (JSON files + a Supabase Storage bucket), not application code — the existing `services/syllabus-map.js` and its tests should not need to change as part of running this pipeline. If they do need to change, treat that as a separate, deliberate task and flag it rather than bundling it in silently.

## Reporting back

When done (or when stopping for the day), report: how many chapters were run, the `titled` / `rejectedAsGarbled` / `noHeadingFound` / `downloadFailed` totals, which grades were completed, and the before/after "681 placeholder" number from the re-scan. That's what gets validated against — not "I ran the script," but the actual measured change in real vs. placeholder title counts.
