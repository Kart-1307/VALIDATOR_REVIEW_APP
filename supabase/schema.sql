-- ============================================================================
-- SAT Question Bank Validator — Supabase schema
-- Safe to re-run: uses IF NOT EXISTS / ADD COLUMN IF NOT EXISTS throughout.
-- Run in your Supabase project's SQL Editor (Dashboard → SQL Editor → New
-- query → paste this whole file → Run).
-- ============================================================================

-- ---------------------------------------------------------------------------
-- 1. PROFILES (spec §2: Validator, Lead Validator/Admin, Read-only/Auditor)
-- ---------------------------------------------------------------------------
create table if not exists public.profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  email text not null,
  name text not null default '',
  role text not null default 'validator' check (role in ('validator', 'admin', 'auditor')),
  active boolean not null default true,
  created_at timestamptz not null default now()
);

-- --- "Invited but hasn't finished signing up yet" tracking ---
-- true only for accounts created via the admin's emailed invite
-- (admin.inviteUserByEmail) that haven't completed their first sign-in yet.
-- Self-service signups are never "pending" this way since they set a
-- password immediately at signup time.
alter table public.profiles add column if not exists invite_pending boolean not null default false;

alter table public.profiles enable row level security;

drop policy if exists "Profiles are viewable by authenticated users" on public.profiles;
create policy "Profiles are viewable by authenticated users"
  on public.profiles for select
  to authenticated
  using (true);

drop policy if exists "Users can update their own profile" on public.profiles;
create policy "Users can update their own profile"
  on public.profiles for update
  to authenticated
  using (auth.uid() = id)
  with check (auth.uid() = id);

drop policy if exists "Admins can update any profile" on public.profiles;
create policy "Admins can update any profile"
  on public.profiles for update
  to authenticated
  using (exists (select 1 from public.profiles p where p.id = auth.uid() and p.role = 'admin'))
  with check (true);

-- ---------------------------------------------------------------------------
-- 1b. VALIDATOR INVITES (spec §2: Admin can invite validators)
-- ---------------------------------------------------------------------------
create table if not exists public.validator_invites (
  email text primary key,
  name text not null,
  role text not null default 'validator' check (role in ('validator', 'admin', 'auditor')),
  invited_at timestamptz not null default now()
);

alter table public.validator_invites enable row level security;

drop policy if exists "Invites viewable by authenticated users" on public.validator_invites;
drop policy if exists "Invites viewable by admins" on public.validator_invites;
create policy "Invites viewable by admins"
  on public.validator_invites for select
  to authenticated
  using (exists (select 1 from public.profiles p where p.id = auth.uid() and p.role = 'admin'));

drop policy if exists "Admins can manage invites" on public.validator_invites;
create policy "Admins can manage invites"
  on public.validator_invites for all
  to authenticated
  using (exists (select 1 from public.profiles p where p.id = auth.uid() and p.role = 'admin'))
  with check (exists (select 1 from public.profiles p where p.id = auth.uid() and p.role = 'admin'));

create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer set search_path = public
as $$
declare
  invited record;
begin
  -- Case-insensitive match, since an admin might type an invite email in a
  -- different case than the one someone actually signs up with.
  select * into invited from public.validator_invites where lower(email) = lower(new.email) limit 1;

  if invited is not null then
    -- new.invited_at is a real auth.users column that Supabase only sets
    -- when the account was created via admin.inviteUserByEmail (the emailed
    -- invite path). Self-service signups leave it null since they set a
    -- password immediately, so there's nothing left "pending".
    insert into public.profiles (id, email, name, role, active, invite_pending)
    values (new.id, new.email, invited.name, invited.role, true, new.invited_at is not null);

    -- Consume the invite so the admin's pre-authorization list stays accurate.
    delete from public.validator_invites where lower(email) = lower(new.email);
  else
    -- If not pre-authorized/invited, set active to false so they are deactivated by default
    insert into public.profiles (id, email, name, role, active)
    values (new.id, new.email, coalesce(new.raw_user_meta_data->>'name', split_part(new.email, '@', 1)), 'validator', false);
  end if;
  return new;
end;
$$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
  after insert on auth.users
  for each row execute procedure public.handle_new_user();

-- --- Clears invite_pending the moment an emailed-invite user actually
-- finishes setting up their account (their very first successful sign-in,
-- e.g. clicking the emailed link and setting a password). Also catches the
-- case where Supabase populates invited_at via a follow-up UPDATE rather
-- than having it present at the initial INSERT (handle_new_user's snapshot
-- of invited_at can otherwise read NULL and get stuck at invite_pending =
-- false forever, even for a genuinely pending invite). ---
create or replace function public.handle_user_auth_state_change()
returns trigger
language plpgsql
security definer set search_path = public
as $$
begin
  -- Case A: invited_at arrives after the initial insert.
  if old.invited_at is null and new.invited_at is not null and new.last_sign_in_at is null then
    update public.profiles set invite_pending = true where id = new.id;
  end if;

  -- Case B: first successful sign-in — invite/onboarding is complete.
  if old.last_sign_in_at is null and new.last_sign_in_at is not null then
    update public.profiles set invite_pending = false where id = new.id;
  end if;

  return new;
end;
$$;

drop trigger if exists on_auth_user_first_sign_in on auth.users;
drop trigger if exists on_auth_user_auth_state_change on auth.users;
create trigger on_auth_user_auth_state_change
  after update on auth.users
  for each row execute procedure public.handle_user_auth_state_change();

-- One-time backfill for rows created before this fix, where invited_at
-- had already arrived (by the time you query it) but invite_pending got
-- stuck at false due to the INSERT-time timing issue above.
update public.profiles p
set invite_pending = true
from auth.users u
where p.id = u.id
  and u.invited_at is not null
  and u.last_sign_in_at is null
  and p.invite_pending = false;

-- ---------------------------------------------------------------------------
-- 2. QUESTIONS (spec §12 data model, flattened to match the app's SATQuestion type)
-- ---------------------------------------------------------------------------
create table if not exists public.questions (
  id text primary key,
  category text not null default 'General',
  sub_skill text,
  question_type text not null default 'mcq',
  image_url text,
  passage text,
  -- Stimulus: separate from `passage` — equations, data tables, or other
  -- supplementary material (esp. common on Math items). Kept as its own
  -- column so it's never merged with/overwritten by the passage text.
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

  -- Self-serve claim/lock (spec §3, §7)
  claimed_by uuid references public.profiles(id) on delete set null,
  claimed_by_name text,
  claimed_at timestamptz,

  -- Admin-assigned queue (spec §3: "admin-assigned queues")
  assigned_to uuid references public.profiles(id) on delete set null,
  assigned_to_name text,

  -- Second-reviewer / consensus mode (spec §7)
  requires_second_review boolean not null default false,
  -- Independent "second opinion" consensus reviews, keyed by validatorId
  -- inside the JSON array (see App.tsx handleSubmitConsensusReview). One
  -- validator does the primary review (the 4-check columns above); up to
  -- 3 OTHER validators can each leave a second opinion here. Capped at
  -- 3 distinct validators per question.
  consensus_reviews jsonb not null default '[]'::jsonb
    check (jsonb_typeof(consensus_reviews) = 'array' and jsonb_array_length(consensus_reviews) <= 3),

  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- Additive migration for anyone who already ran an earlier version of this file.
alter table public.questions add column if not exists sub_skill text;
alter table public.questions add column if not exists assigned_to uuid references public.profiles(id) on delete set null;
alter table public.questions add column if not exists assigned_to_name text;
alter table public.questions add column if not exists requires_second_review boolean not null default false;
alter table public.questions add column if not exists consensus_reviews jsonb not null default '[]'::jsonb;
-- Question type + supporting graphic (spec §4)
alter table public.questions add column if not exists question_type text not null default 'mcq';
alter table public.questions add column if not exists image_url text;
-- Stimulus (equations/data tables/etc., separate from passage) — additive
-- migration for anyone who already ran an earlier version of this file.
alter table public.questions add column if not exists stimulus text;

-- Cap consensus_reviews at 3 distinct "second opinion" validators, separate
-- from the one primary reviewer (for installs that already had this column
-- before the cap was added/changed above).
alter table public.questions drop constraint if exists questions_consensus_reviews_check;
alter table public.questions add constraint questions_consensus_reviews_check
  check (jsonb_typeof(consensus_reviews) = 'array' and jsonb_array_length(consensus_reviews) <= 3);

alter table public.questions enable row level security;

drop policy if exists "Questions are viewable by authenticated users" on public.questions;
create policy "Questions are viewable by authenticated users"
  on public.questions for select
  to authenticated
  using (true);

-- Only active admins can write new questions (deactivated accounts and
-- non-admins are locked out at the DB level; frontend upload UI is admin-only too).
drop policy if exists "Active users can insert questions" on public.questions;
create policy "Active users can insert questions"
  on public.questions for insert
  to authenticated
  with check (exists (select 1 from public.profiles p where p.id = auth.uid() and p.active = true and p.role = 'admin'));

drop policy if exists "Active users can update questions" on public.questions;
create policy "Active users can update questions"
  on public.questions for update
  to authenticated
  using (exists (select 1 from public.profiles p where p.id = auth.uid() and p.active = true))
  with check (true);

drop policy if exists "Admins can delete questions" on public.questions;
create policy "Admins can delete questions"
  on public.questions for delete
  to authenticated
  using (exists (select 1 from public.profiles p where p.id = auth.uid() and p.role = 'admin'));

create or replace function public.set_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

drop trigger if exists questions_set_updated_at on public.questions;
create trigger questions_set_updated_at
  before update on public.questions
  for each row execute procedure public.set_updated_at();

-- ---------------------------------------------------------------------------
-- 3. AUDIT LOG (spec §8: immutable, append-only, exportable)
-- ---------------------------------------------------------------------------
create table if not exists public.audit_log (
  id uuid primary key default gen_random_uuid(),
  "timestamp" timestamptz not null default now(),
  action text not null,
  question_id text,
  description text not null,
  user_id uuid references public.profiles(id) on delete set null,
  user_name text
);

alter table public.audit_log enable row level security;

drop policy if exists "Audit log is viewable by authenticated users" on public.audit_log;
create policy "Audit log is viewable by authenticated users"
  on public.audit_log for select
  to authenticated
  using (true);

drop policy if exists "Active users can append audit entries" on public.audit_log;
create policy "Active users can append audit entries"
  on public.audit_log for insert
  to authenticated
  with check (exists (select 1 from public.profiles p where p.id = auth.uid() and p.active = true));

-- Deliberately no update/delete policy for anyone — immutable, per spec §8.

-- ---------------------------------------------------------------------------
-- 4. APP SETTINGS (admin-configurable: rejection webhook, consensus sample rate)
-- ---------------------------------------------------------------------------
create table if not exists public.app_settings (
  id int primary key default 1,
  rejection_webhook_url text,
  consensus_sample_rate numeric not null default 0.1,
  constraint app_settings_singleton check (id = 1)
);

insert into public.app_settings (id) values (1) on conflict (id) do nothing;

alter table public.app_settings enable row level security;

drop policy if exists "Settings are viewable by authenticated users" on public.app_settings;
create policy "Settings are viewable by authenticated users"
  on public.app_settings for select
  to authenticated
  using (true);

drop policy if exists "Admins can update settings" on public.app_settings;
create policy "Admins can update settings"
  on public.app_settings for update
  to authenticated
  using (exists (select 1 from public.profiles p where p.id = auth.uid() and p.role = 'admin'))
  with check (true);

-- ---------------------------------------------------------------------------
-- 5. REALTIME (spec §7: near-real-time status sync across validators)
-- ---------------------------------------------------------------------------
do $$
begin
  if not exists (
    select 1 from pg_publication_tables
    where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'questions'
  ) then
    alter publication supabase_realtime add table public.questions;
  end if;
  if not exists (
    select 1 from pg_publication_tables
    where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'audit_log'
  ) then
    alter publication supabase_realtime add table public.audit_log;
  end if;
end $$;

-- ---------------------------------------------------------------------------
-- 6. First admin — run this AFTER you've signed up once in the app, so your
-- own row exists in public.profiles. Replace the email below.
-- ---------------------------------------------------------------------------
-- update public.profiles set role = 'admin' where email = 'you@example.com';