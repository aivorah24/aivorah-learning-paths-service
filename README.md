# Aivorah Learning Paths Service

Standalone microservice for the Student Learning Path flow — syllabus
chapters/topics, resolved topic resources (Read/Listen/Practice content),
and IB PYP/CBSE practice quiz generation — extracted from `ai-mentor/server`.

## Structure

```
routes/
  syllabus.js   — GET /current, GET /topic/:topicId/resources
  ibpyp.js      — POST /quiz, /explain-wrong, /track-result
services/
  supabase.js               — Supabase client
  analytics.js               — event logging (logEvent)
  syllabus-map.js            — authoritative book chapter structure, read
                                from data/curricula/*.json
  curriculum/
    types.js                 — shared resource-type constants
    resourceResolver.js      — resolves a topic's 8 resource types from
                                the topic_resources table
data/
  curricula/                 — per-book chapter JSON (extracted from the
                                NCERT/CBSE textbook PDFs), read by
                                syllabus-map.js
```

The teacher-authoring side of syllabus management (upload a book, AI
extraction, review/publish) deliberately stayed in the `ai-mentor` monolith
— it's a separate concern from what a student reads here, and pulls in file
uploads and a job queue this service doesn't need. `GET /ibpyp/lesson-content`
(legacy scene-based lesson generation, used by `TopicLessonScreen`, not the
Learning Path flow) also stayed behind for the same reason.

## Setup

```bash
npm install
cp .env.example .env   # fill in real keys
npm run dev             # nodemon, or `npm start` for a plain run
```

Runs on `PORT` (default `3014`).

## Endpoints

- `GET /teacher/syllabus/current?grade=&subject=&curriculum=&schoolId=` —
  a subject's full chapter/topic structure, merged against the book's
  authoritative chapter list (`syllabus-map.js`) so chapters without a
  published lesson yet still appear (`pending: true`) instead of vanishing.
- `GET /teacher/syllabus/topic/:topicId/resources` — resolves all 8 resource
  types (AI_EXPLANATION, IMAGES, AUDIO, PRACTICE, etc.) for one DB-backed
  topic from `topic_resources`.
- `POST /ibpyp/quiz` — `{ topic, grade, subject, curriculum, passageText?,
  topicId?, userEmail?, role? }` → `{ questions, topic, grade, subject }`.
  Serves the textbook's own stored exercises verbatim when a `topicId` has
  one; otherwise generates a 5-question mixed MCQ/fill-blank quiz via Groq.
- `POST /ibpyp/explain-wrong` — `{ topic, subject, grade, question,
  wrongAnswer, correctAnswer }` → `{ explanation }`. A warm, encouraging
  explanation for a wrong answer.
- `POST /ibpyp/track-result` — logs a completed quiz attempt to analytics.
- `/read-aloud/*` — student Read Aloud (signed-in student only, `Authorization:
  Bearer <Firebase ID token>`): `GET passages?grade=&lexile=`, `POST passage`,
  `GET calibration?grade=`, `GET|POST lexile`, `POST assess`, `GET history`,
  `POST transcribe` / `transcribe-live` (multipart `audio` + `passage`, Groq
  Whisper), `POST tts` (ElevenLabs, shipped passages only, cached on
  Cloudinary). Needs `GROQ_API_KEY`, `ELEVENLABS_API_KEY` and the
  `read_aloud_levels` / `read_aloud_sessions` tables (aivorah-db `0008`).
- `GET /health`

## Branching

`main` is protected by convention — no direct pushes. Work on a feature
branch and open a PR (see `.github/PULL_REQUEST_TEMPLATE.md`).
