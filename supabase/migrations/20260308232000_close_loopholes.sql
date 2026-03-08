-- ══════════════════════════════════════════════════════════════
-- Close accountability loopholes
-- ══════════════════════════════════════════════════════════════

-- ─── 1. Block direct punishment_acknowledged edits ───────────
-- Users could bypass the "I will do better" gate by calling
-- supabase.from('missed_days').update({ punishment_acknowledged: true })
-- Fix: add punishment_acknowledged to the guard triggers

create or replace function guard_missed_days_update()
returns trigger
language plpgsql
as $$
begin
  if current_user <> 'postgres' then
    if new.user_id is distinct from old.user_id
       or new.date is distinct from old.date
       or new.excuse is distinct from old.excuse
       or new.was_avoidable is distinct from old.was_avoidable
       or new.excuse_id is distinct from old.excuse_id
       or new.required_votes is distinct from old.required_votes
       or new.partner_count_snapshot is distinct from old.partner_count_snapshot
       or new.verdict is distinct from old.verdict
       or new.vote_accepts is distinct from old.vote_accepts
       or new.vote_rejects is distinct from old.vote_rejects
       or new.vote_total is distinct from old.vote_total
       or new.selected_punishment is distinct from old.selected_punishment
       or new.selected_punishment_votes is distinct from old.selected_punishment_votes
       or new.created_at is distinct from old.created_at then
      raise exception 'Direct outcome edits are blocked';
    end if;

    -- Punishment acknowledged requires a completed punishment task
    if new.punishment_acknowledged is distinct from old.punishment_acknowledged then
      if new.punishment_acknowledged = true then
        if not exists (
          select 1 from punishment_tasks
          where source_type = 'missed_day'
            and source_id = old.id
            and completed = true
        ) then
          raise exception 'Cannot acknowledge punishment without completing the punishment task';
        end if;
      else
        raise exception 'Cannot un-acknowledge a punishment';
      end if;
    end if;
  end if;
  return new;
end;
$$;

create or replace function guard_missed_goal_deadlines_update()
returns trigger
language plpgsql
as $$
begin
  if current_user <> 'postgres' then
    if new.user_id is distinct from old.user_id
       or new.goal_id is distinct from old.goal_id
       or new.deadline is distinct from old.deadline
       or new.excuse is distinct from old.excuse
       or new.requested_deadline is distinct from old.requested_deadline
       or new.extension_applied is distinct from old.extension_applied
       or new.was_avoidable is distinct from old.was_avoidable
       or new.excuse_id is distinct from old.excuse_id
       or new.required_votes is distinct from old.required_votes
       or new.partner_count_snapshot is distinct from old.partner_count_snapshot
       or new.verdict is distinct from old.verdict
       or new.vote_accepts is distinct from old.vote_accepts
       or new.vote_rejects is distinct from old.vote_rejects
       or new.vote_total is distinct from old.vote_total
       or new.selected_punishment is distinct from old.selected_punishment
       or new.selected_punishment_votes is distinct from old.selected_punishment_votes
       or new.created_at is distinct from old.created_at then
      raise exception 'Direct outcome edits are blocked';
    end if;

    -- Punishment acknowledged requires a completed punishment task
    if new.punishment_acknowledged is distinct from old.punishment_acknowledged then
      if new.punishment_acknowledged = true then
        if not exists (
          select 1 from punishment_tasks
          where source_type = 'deadline'
            and source_id = old.id
            and completed = true
        ) then
          raise exception 'Cannot acknowledge punishment without completing the punishment task';
        end if;
      else
        raise exception 'Cannot un-acknowledge a punishment';
      end if;
    end if;
  end if;
  return new;
end;
$$;


-- ─── 2. Excuse minimum length at DB level ───────────────────
-- Users could submit empty/short excuses via direct API calls

alter table missed_days drop constraint if exists missed_days_excuse_length;
alter table missed_days
  add constraint missed_days_excuse_length
  check (length(trim(excuse)) >= 80);

alter table missed_goal_deadlines drop constraint if exists missed_goal_deadlines_excuse_length;
alter table missed_goal_deadlines
  add constraint missed_goal_deadlines_excuse_length
  check (length(trim(excuse)) >= 80);


-- ─── 3. Punishment task completion enforcement ──────────────
-- Users could mark tasks done instantly. Add minimum time and
-- require proof for time-based punishments.
-- Also block users from un-completing or deleting tasks.

-- Block direct deletes on punishment_tasks
drop policy if exists "Users manage own punishment tasks" on punishment_tasks;
create policy "Users read own punishment tasks"
  on punishment_tasks for select using (auth.uid() = user_id);
create policy "Users update own punishment tasks"
  on punishment_tasks for update using (auth.uid() = user_id)
  with check (auth.uid() = user_id);
-- No INSERT policy for users (only the trigger inserts)
-- No DELETE policy (tasks cannot be deleted)

create or replace function guard_punishment_task_update()
returns trigger
language plpgsql
as $$
begin
  -- Cannot change description, source, or due date
  if new.source_type is distinct from old.source_type
     or new.source_id is distinct from old.source_id
     or new.user_id is distinct from old.user_id
     or new.description is distinct from old.description
     or new.due_date is distinct from old.due_date
     or new.created_at is distinct from old.created_at then
    raise exception 'Punishment task metadata is immutable';
  end if;

  -- Cannot un-complete
  if old.completed = true and new.completed is distinct from true then
    raise exception 'Cannot un-complete a punishment task';
  end if;

  -- Must wait at least 1 hour after creation before completing
  if new.completed = true and old.completed = false then
    if now() < old.created_at + interval '1 hour' then
      raise exception 'Punishment task cannot be completed within 1 hour of assignment';
    end if;
  end if;

  return new;
end;
$$;

drop trigger if exists trg_guard_punishment_task_update on punishment_tasks;
create trigger trg_guard_punishment_task_update
  before update on punishment_tasks
  for each row execute function guard_punishment_task_update();


-- ─── 4. Move rest days to server ────────────────────────────
-- Rest days in localStorage can be tampered via DevTools.
-- Store them server-side in a user_settings table.

create table if not exists user_settings (
  user_id uuid references auth.users(id) on delete cascade primary key,
  rest_days int[] default '{}',
  reminder_hour int default 21 check (reminder_hour between 0 and 23),
  updated_at timestamptz default now()
);

alter table user_settings enable row level security;
drop policy if exists "Users manage own settings" on user_settings;
create policy "Users manage own settings"
  on user_settings for all using (auth.uid() = user_id)
  with check (auth.uid() = user_id);

-- Guard: max 2 rest days per week to prevent abuse
create or replace function guard_rest_days()
returns trigger
language plpgsql
as $$
begin
  if array_length(new.rest_days, 1) > 2 then
    raise exception 'Maximum 2 rest days per week allowed';
  end if;

  -- Validate values are 0-6 (Sun-Sat)
  for i in 1..coalesce(array_length(new.rest_days, 1), 0) loop
    if new.rest_days[i] < 0 or new.rest_days[i] > 6 then
      raise exception 'Rest day values must be between 0 (Sun) and 6 (Sat)';
    end if;
  end loop;

  new.updated_at := now();
  return new;
end;
$$;

drop trigger if exists trg_guard_rest_days on user_settings;
create trigger trg_guard_rest_days
  before insert or update on user_settings
  for each row execute function guard_rest_days();


-- ─── 5. Block goal deactivation if active goals would drop to 0 ─
-- User could deactivate all goals to avoid proof requirements

create or replace function guard_goal_deactivation()
returns trigger
language plpgsql
as $$
declare
  remaining int;
begin
  if current_user = 'postgres' then return new; end if;

  -- Only check when deactivating (active goes from true to false)
  if old.active = true and new.active = false then
    select count(*) into remaining
    from goals
    where user_id = old.user_id
      and active = true
      and id <> old.id;

    if remaining < 1 then
      raise exception 'Cannot deactivate your last active goal. Add a new goal first.';
    end if;
  end if;

  return new;
end;
$$;

drop trigger if exists trg_guard_goal_deactivation on goals;
create trigger trg_guard_goal_deactivation
  before update on goals
  for each row execute function guard_goal_deactivation();


-- ─── 6. Prevent missed_days deletion ────────────────────────
-- Users should never be able to delete their missed day records

drop policy if exists "Users delete own missed_days" on missed_days;
-- (No delete policy = deletes are blocked by RLS)

drop policy if exists "Users delete own missed_goal_deadlines" on missed_goal_deadlines;
-- (No delete policy = deletes are blocked by RLS)
