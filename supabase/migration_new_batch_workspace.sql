-- ============================================================================
-- New Batch Workspace — additive migration
-- Safe to re-run: uses IF NOT EXISTS / ADD COLUMN IF NOT EXISTS throughout.
-- Run in your Supabase project's SQL Editor AFTER schema.sql has already
-- been applied at least once (this depends on public.profiles,
-- public.set_updated_at(), and public.bulk_action_snapshots existing).
-- ============================================================================

-- ---------------------------------------------------------------------------
-- 1. QUESTIONS_BATCH2 — an exact structural clone of public.questions.
-- Used exclusively by the "New Batch" tab (NewBatchWorkspace.tsx), which is
-- fully isolated from the main Curator tab's `questions` table. It reuses
-- the same rowToQuestion / questionToRow mappers, so the column set below
-- must stay identical to public.questions.
-- ---------------------------------------------------------------------------
create table if not exists public.questions_batch2 (
  id text primary key,
  category text not null default 'General',
  sub_skill text,
  question_type text not null default 'mcq',
  image_url text,
  passage text,
  stimulus text,
  question text not null,
  choices jsonb not null default '{}'::jsonb,
  correct_answer text not null default 'A',
  explanation text not null default '',
  module text,
  section text,
  difficulty text not null default 'medium',
  generator_run_id text,

  review_status text not null default 'pending'
    check (review_status in ('pending', 'approved', 'rejected', 'needs_revision')),

  validator_status text,
  validator_feedback text,
  similarity_score numeric,
  similar_question_id text,

  formation_ok boolean,
  answer_ok boolean,
  category_ok boolean,
  category_override text,
  difficulty_ok boolean,
  difficulty_override text,

  status_override text check (status_override in ('approved', 'rejected', 'needs_revision')),
  status_override_justification text,

  comments jsonb not null default '[]'::jsonb,

  claimed_by uuid references public.profiles(id) on delete set null,
  claimed_by_name text,
  claimed_at timestamptz,

  assigned_to uuid references public.profiles(id) on delete set null,
  assigned_to_name text,

  requires_second_review boolean not null default false,
  consensus_reviews jsonb not null default '[]'::jsonb
    check (jsonb_typeof(consensus_reviews) = 'array' and jsonb_array_length(consensus_reviews) <= 3),

  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- ---------------------------------------------------------------------------
-- 1b. Batch tracking columns — added after initial launch. Tags each row
-- with which JSON upload introduced it, so validators can filter to "just
-- the new stuff" and admins can bulk-remove a bad upload. batch_uploaded_at
-- is the effectively-unique key (set once, at first-insert time, and never
-- touched again on later updates to that same question — see
-- NewBatchWorkspace.tsx's readFiles()); batch_label is the human-facing
-- name, defaulting to a formatted timestamp if the admin leaves it blank.
-- Intentionally NOT added to public.questions — these columns are New Batch
-- only, which is why NewBatchWorkspace.tsx uses its own row<->question
-- mapper wrappers instead of the shared ones in lib/mappers.ts.
-- ---------------------------------------------------------------------------
alter table public.questions_batch2 add column if not exists batch_label text;
alter table public.questions_batch2 add column if not exists batch_uploaded_at timestamptz;

create index if not exists questions_batch2_batch_uploaded_at_idx
  on public.questions_batch2 (batch_uploaded_at);

alter table public.questions_batch2 enable row level security;

-- Same policy shape as public.questions (viewable by any authenticated
-- user; only active admins can insert; auditors are excluded from
-- write/delete, matching the read-only-at-the-DB-level fix on the main table).
drop policy if exists "Batch2 questions are viewable by authenticated users" on public.questions_batch2;
create policy "Batch2 questions are viewable by authenticated users"
  on public.questions_batch2 for select
  to authenticated
  using (true);

drop policy if exists "Active users can insert batch2 questions" on public.questions_batch2;
create policy "Active users can insert batch2 questions"
  on public.questions_batch2 for insert
  to authenticated
  with check (exists (select 1 from public.profiles p where p.id = auth.uid() and p.active = true and p.role = 'admin'));

drop policy if exists "Active users can update batch2 questions" on public.questions_batch2;
create policy "Active users can update batch2 questions"
  on public.questions_batch2 for update
  to authenticated
  using (exists (select 1 from public.profiles p where p.id = auth.uid() and p.active = true and p.role != 'auditor'))
  with check (true);

drop policy if exists "Admins can delete batch2 questions" on public.questions_batch2;
create policy "Admins can delete batch2 questions"
  on public.questions_batch2 for delete
  to authenticated
  using (exists (select 1 from public.profiles p where p.id = auth.uid() and p.role = 'admin'));

drop trigger if exists questions_batch2_set_updated_at on public.questions_batch2;
create trigger questions_batch2_set_updated_at
  before update on public.questions_batch2
  for each row execute procedure public.set_updated_at();

-- Ensure full row (including TOASTed text columns) is emitted in Realtime UPDATE events
alter table public.questions_batch2 replica identity full;

do $$
begin
  if not exists (
    select 1 from pg_publication_tables
    where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'questions_batch2'
  ) then
    alter publication supabase_realtime add table public.questions_batch2;
  end if;
end $$;

-- ---------------------------------------------------------------------------
-- 2. QUESTION_SNAPSHOTS — per-question revert history.
-- NOTE: this table is already referenced by the *existing* App.tsx (single-
-- question snapshot on every state-changing action, restore-from-History-
-- drawer) but was never actually defined in schema.sql. NewBatchWorkspace
-- also writes/reads it, scoped by question_id, so it's a shared table
-- across both the Curator tab and the New Batch tab — create it here if it
-- doesn't already exist in your project.
-- ---------------------------------------------------------------------------
create table if not exists public.question_snapshots (
  id uuid primary key default gen_random_uuid(),
  created_at timestamptz not null default now(),
  question_id text not null,
  action_type text not null,
  performed_by uuid references public.profiles(id) on delete set null,
  performed_by_name text,
  snapshot jsonb not null,
  restored boolean not null default false
);

create index if not exists question_snapshots_question_id_idx
  on public.question_snapshots (question_id, created_at desc);

alter table public.question_snapshots enable row level security;

drop policy if exists "Snapshots are viewable by authenticated users" on public.question_snapshots;
create policy "Snapshots are viewable by authenticated users"
  on public.question_snapshots for select
  to authenticated
  using (true);

-- Same auditor-exclusion pattern as bulk_action_snapshots / audit_log.
drop policy if exists "Active users can create question snapshots" on public.question_snapshots;
create policy "Active users can create question snapshots"
  on public.question_snapshots for insert
  to authenticated
  with check (exists (select 1 from public.profiles p where p.id = auth.uid() and p.active = true and p.role != 'auditor'));

-- Only the `restored` flag ever gets flipped (see handleRestoreQuestionSnapshot
-- in App.tsx / NewBatchWorkspace.tsx) — never a full row rewrite.
drop policy if exists "Active users can mark question snapshots restored" on public.question_snapshots;
create policy "Active users can mark question snapshots restored"
  on public.question_snapshots for update
  to authenticated
  using (exists (select 1 from public.profiles p where p.id = auth.uid() and p.active = true and p.role != 'auditor'))
  with check (true);

-- ---------------------------------------------------------------------------
-- 3. BULK_ACTION_SNAPSHOTS — no schema change needed.
-- This table already exists (schema.sql §6) and already stores `snapshot`
-- as JSON with no fixed reference to a specific source table, so it works
-- for questions_batch2 rows as-is. NewBatchWorkspace tags its own rows with
-- an action_type prefix ('batch2:...') purely at the application level so
-- its "Undo Last Bulk Action" never picks up a snapshot created by the main
-- Curator tab (or vice versa) — no RLS or column change is required here.
-- ---------------------------------------------------------------------------