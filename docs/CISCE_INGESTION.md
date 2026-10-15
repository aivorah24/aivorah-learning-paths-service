# Official CISCE curriculum ingestion

Official ICSE / ISC / Primary / Preschool curriculum from cisce.org, kept apart
from everything else:

| What | Where |
|---|---|
| Source registry | `data/cisce/source-registry.json` + Supabase `cisce_sources` |
| Canonical curriculum tree | Supabase `cisce_curriculum_nodes` (`curriculum_id = 'cisce'`, `version` per exam year, e.g. `icse-2028`) |
| Vectors | Qdrant collection `cisce_curriculum_v1` (384-d cosine, `Xenova/all-MiniLM-L6-v2`) |
| Coverage | `data/cisce/reports/coverage-<date>.{json,md}` + Supabase `cisce_coverage` |
| Downloaded PDFs, extractions, run state | `.cisce-cache/` (git-ignored, local only) |

Schema: aivorah-db migration `0017_cisce_official_curriculum.sql`.

**Why a new Qdrant collection, not a namespaced payload in `ai_mentor_content`:**
`services/boardSyllabus.js` already scrolls `ai_mentor_content` by `curriculum = "ICSE"`, so official
points there would silently merge with the AI-generated outline; a separate collection makes mixing impossible
and lets a version be re-indexed or dropped without touching CBSE/IB/Cambridge.

## What is not touched

- The AI-generated ICSE outline (monolith `scripts/ingest-icse-cambridge-all.js`: `syllabus_chapters`
  where `curriculum = 'ICSE'`, grades `Class I`..`Class X`, plus its `ai_mentor_content` points). It is only
  *read* (coverage, `--check-supplementary`) and labelled `SUPPLEMENTARY_ONLY` by the
  `icse_supplementary_content` view.
- CBSE/NCERT (`aivorah_curriculum_chunks_v1`), IB (`ai_mentor_content`), Cambridge.
- The student UI: ICSE topics stay "Coming soon". `cisce_curriculum_nodes.approved` is always written `false`;
  serving official content to students is a separate, later change gated on `VERIFIED_OFFICIAL` + approval.

Grade labels: data uses `Preschool`, `Class I`..`Class XII` (built by `boardSyllabus.classLabel`);
`student_grade` in the Qdrant payload is the student-facing `Grade N`.

## Stages

`discover → download (validate) → extract → normalise → validate → persist → index`, then `coverage`.

- **discover** — index pages → year pages → PDF links (plain hrefs and Elementor `data-ra-element-link` JSON).
  Browser User-Agent; ≥1 s between requests.
- **download** — records HTTP status, final URL, content-type, sha256, bytes, page count. A file must be
  non-empty, have a `%PDF-` header, not be an HTML error page, and parse. 404/410 → `DEAD`; 403/5xx/network → `UNREACHABLE`.
  Regulations/circulars/notices stop here (metadata only).
- **extract** — text per page; OCR (poppler `pdftoppm` + `tesseract`) **only** on pages with no text layer.
  Without an OCR engine those pages are left empty and the document can only be `OFFICIAL_PARTIAL`.
  Each parse runs in its own child process, so a malformed PDF cannot crash an overnight run.
- **normalise** — canonical JSON from the document's own headings only (`CLASS IX`, `1. Unit`, `(i) topic`).
  Nothing is generated.
- **validate** — schema + provenance rules; failures never reach the database.
- **persist / index** — idempotent upserts with deterministic ids. They write only to the Dev Supabase project
  (`evlqkcozespsfrnuhevf`); Test (`xmwzifxlpmgsrxgxsgan`) and the refs in the aivorah-db README are always refused.
- **store** (opt-in, not in the default run) — private Cloudinary copy (`type: authenticated`) only with
  `--store-pdfs` and `CISCE_CLOUDINARY_APPROVED_BY=<who approved>`.

Coverage statuses: `VERIFIED_OFFICIAL`, `OFFICIAL_PARTIAL`, `EXTRACTION_FAILED`, `SUPPLEMENTARY_ONLY`, `AWAITING_SOURCE`.

## Running it (on a machine that can reach cisce.org, Supabase and Qdrant)

```bash
npm install
# .env: SUPABASE_URL=https://evlqkcozespsfrnuhevf.supabase.co, SUPABASE_SERVICE_KEY, QDRANT_URL, QDRANT_API_KEY

npm run cisce:dry-run                       # read-only: discover, download, extract, normalise, validate, coverage
npm run cisce:overnight                     # full run with --resume, retries failed sources, logs to .cisce-cache/logs/overnight.log
nohup npm run cisce:overnight >/dev/null 2>&1 &   # detached; follow with: tail -f .cisce-cache/logs/overnight.log
npm run cisce:coverage                      # report only

node scripts/cisce-ingest.cjs run --source icse-2028-physics --stage download,extract --dry-run
node scripts/cisce-ingest.cjs --help
```

Flags: `--dry-run`, `--resume`, `--source <id,...>`, `--stage <x,...>`, `--concurrency N`,
`--check-supplementary`, `--store-pdfs`, `--cache-dir`, `--log-file`.

Stopping is safe at any point: state is saved after every stage of every source, and `--resume` continues
from there (a changed PDF — new sha256 — is re-processed from scratch).
