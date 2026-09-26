-- Saved AI lesson blocks (Learn tab), keyed by curriculum + grade + subject + topic.
-- Created by hand in Dev only; the Test database had no such table, so every lesson open regenerated with the LLM.
-- Run once in the Supabase SQL editor of each environment (Test, Prod).
create table if not exists public.topic_ai_enrichment (
  id uuid primary key default gen_random_uuid(),
  curriculum text not null,
  grade text not null,
  subject text not null,
  topic text not null,
  content_type text,
  structured_content jsonb not null,
  source_chunk_ids text[],
  source_reference text,
  schema_version integer not null default 1,
  prompt_version text,
  model text,
  generated_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (curriculum, grade, subject, topic)
);

-- Only the service role (this service) reads/writes it.
alter table public.topic_ai_enrichment enable row level security;

-- Make PostgREST see the new table immediately.
notify pgrst, 'reload schema';
