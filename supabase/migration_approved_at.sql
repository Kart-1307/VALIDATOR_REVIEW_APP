-- Adds `reviewed_at` (date of the current review decision: approved / rejected / needs revision)
-- to both question tables. Run once in the Supabase SQL editor BEFORE deploying the matching
-- frontend (the New Batch -> main merge writes reviewed_at). Safe to run if an earlier
-- version of this migration (approved_at) was already applied.

begin;

do $$
begin
  if exists (select 1 from information_schema.columns where table_schema='public' and table_name='questions' and column_name='approved_at') then
    alter table public.questions rename column approved_at to reviewed_at;
  end if;
  if exists (select 1 from information_schema.columns where table_schema='public' and table_name='questions_batch2' and column_name='approved_at') then
    alter table public.questions_batch2 rename column approved_at to reviewed_at;
  end if;
end $$;

alter table public.questions        add column if not exists reviewed_at timestamptz;
alter table public.questions_batch2 add column if not exists reviewed_at timestamptz;

drop trigger if exists questions_set_approved_at on public.questions;
drop trigger if exists questions_batch2_set_approved_at on public.questions_batch2;
drop function if exists public.set_approved_at();
drop index if exists public.questions_approved_at_idx;
drop index if exists public.questions_batch2_approved_at_idx;

-- Backfill without touching updated_at (its trigger is paused for the update): latest matching
-- per-question audit entry ('approve' / 'reject') if one exists, otherwise the row's updated_at.
alter table public.questions        disable trigger questions_set_updated_at;
alter table public.questions_batch2 disable trigger questions_batch2_set_updated_at;

update public.questions q
set reviewed_at = coalesce(
  (select max(a."timestamp") from public.audit_log a
   where a.question_id = q.id
     and a.action = case q.review_status when 'approved' then 'approve' when 'rejected' then 'reject' end),
  q.updated_at)
where q.review_status is not null and q.review_status <> 'pending' and q.reviewed_at is null;

update public.questions_batch2 q
set reviewed_at = coalesce(
  (select max(a."timestamp") from public.audit_log a
   where a.question_id = q.id
     and a.action = case q.review_status when 'approved' then 'approve' when 'rejected' then 'reject' end),
  q.updated_at)
where q.review_status is not null and q.review_status <> 'pending' and q.reviewed_at is null;

alter table public.questions        enable trigger questions_set_updated_at;
alter table public.questions_batch2 enable trigger questions_batch2_set_updated_at;

-- Stamped when review_status changes to a decision, kept while the status is unchanged,
-- cleared when back to pending. A value supplied explicitly (e.g. by a merge) is respected.
create or replace function public.set_reviewed_at()
returns trigger
language plpgsql
as $$
begin
  if new.review_status is null or new.review_status = 'pending' then
    new.reviewed_at := null;
  elsif tg_op = 'INSERT' then
    new.reviewed_at := coalesce(new.reviewed_at, now());
  elsif new.review_status is distinct from old.review_status then
    if new.reviewed_at is null or new.reviewed_at = old.reviewed_at then
      new.reviewed_at := now();
    end if;
  else
    new.reviewed_at := coalesce(new.reviewed_at, old.reviewed_at, now());
  end if;
  return new;
end;
$$;

drop trigger if exists questions_set_reviewed_at on public.questions;
create trigger questions_set_reviewed_at
  before insert or update on public.questions
  for each row execute procedure public.set_reviewed_at();

drop trigger if exists questions_batch2_set_reviewed_at on public.questions_batch2;
create trigger questions_batch2_set_reviewed_at
  before insert or update on public.questions_batch2
  for each row execute procedure public.set_reviewed_at();

create index if not exists questions_reviewed_at_idx on public.questions (reviewed_at);
create index if not exists questions_batch2_reviewed_at_idx on public.questions_batch2 (reviewed_at);

commit;
