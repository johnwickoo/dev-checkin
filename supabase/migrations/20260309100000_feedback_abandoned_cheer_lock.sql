-- ══════════════════════════════════════════════════════════════
-- Feedback page, abandoned goals tracking, cheer page lock
-- ══════════════════════════════════════════════════════════════


-- ─── 1. Feedback table ──────────────────────────────────────
-- Public feedback form for v1 users. Anyone can submit,
-- nobody can read via API (admin-only via dashboard).

create table if not exists feedback (
  id uuid default gen_random_uuid() primary key,
  email text,
  name text,
  category text check (category in ('bug', 'feature', 'improvement', 'other')) default 'other',
  message text not null check (length(trim(message)) between 5 and 2000),
  created_at timestamptz default now()
);

alter table feedback enable row level security;

-- Anyone can insert, no SELECT/UPDATE/DELETE = reads blocked by RLS
drop policy if exists "Anyone can insert feedback" on feedback;
create policy "Anyone can insert feedback"
  on feedback for insert with check (true);

-- Rate-limited submission RPC
create or replace function submit_feedback(
  p_email text,
  p_name text,
  p_category text,
  p_message text
)
returns table(status text, id uuid)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_email text;
  v_message text;
  v_category text;
  v_today_count int;
  v_new_id uuid;
begin
  v_email := lower(trim(coalesce(p_email, '')));
  v_message := trim(coalesce(p_message, ''));
  v_category := coalesce(nullif(trim(p_category), ''), 'other');

  if length(v_message) < 5 or length(v_message) > 2000 then
    return query select 'invalid_message'::text, null::uuid;
    return;
  end if;

  if v_category not in ('bug', 'feature', 'improvement', 'other') then
    v_category := 'other';
  end if;

  -- Rate limit: 5 per email per day
  if v_email <> '' then
    select count(*) into v_today_count
    from feedback where email = v_email and created_at >= now() - interval '1 day';
    if v_today_count >= 5 then
      return query select 'rate_limited'::text, null::uuid;
      return;
    end if;
  end if;

  insert into feedback (email, name, category, message)
  values (
    nullif(v_email, ''),
    nullif(trim(coalesce(p_name, '')), ''),
    v_category,
    v_message
  )
  returning feedback.id into v_new_id;

  return query select 'ok'::text, v_new_id;
end;
$$;

revoke all on function submit_feedback(text, text, text, text) from public;
grant execute on function submit_feedback(text, text, text, text) to anon, authenticated;


-- ─── 2. Abandoned goals tracking ────────────────────────────
-- When a goal is deactivated without completion, track when
-- and why. After 30 days, surface it for accountability.

alter table goals add column if not exists abandoned_at timestamptz;
alter table goals add column if not exists abandoned_reason text;
alter table goals add column if not exists abandonment_email_sent boolean default false;

-- Auto-set abandoned_at when goal deactivated without completion
create or replace function track_goal_abandonment()
returns trigger
language plpgsql
as $$
begin
  -- Goal deactivated without completion = abandoned
  if new.active = false and new.completed_at is null and old.active = true then
    new.abandoned_at := now();
  end if;
  -- Goal reactivated = clear abandonment
  if new.active = true and old.active = false then
    new.abandoned_at := null;
    new.abandoned_reason := null;
    new.abandonment_email_sent := false;
  end if;
  return new;
end;
$$;

drop trigger if exists trg_track_goal_abandonment on goals;
create trigger trg_track_goal_abandonment
  before update on goals
  for each row execute function track_goal_abandonment();

-- RPC to submit abandonment reason
create or replace function submit_abandonment_reason(
  p_goal_id uuid,
  p_reason text
)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  if auth.uid() is null then
    raise exception 'Authentication required';
  end if;

  update goals
  set abandoned_reason = trim(p_reason)
  where id = p_goal_id
    and user_id = auth.uid()
    and active = false
    and completed_at is null;
end;
$$;

revoke all on function submit_abandonment_reason(uuid, text) from public;
grant execute on function submit_abandonment_reason(uuid, text) to authenticated;

-- RPC to mark abandonment email as sent (prevents re-sending)
create or replace function mark_abandonment_email_sent(p_goal_id uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  if auth.uid() is null then
    raise exception 'Authentication required';
  end if;

  update goals
  set abandonment_email_sent = true
  where id = p_goal_id
    and user_id = auth.uid()
    and active = false
    and completed_at is null
    and abandoned_at is not null;
end;
$$;

revoke all on function mark_abandonment_email_sent(uuid) from public;
grant execute on function mark_abandonment_email_sent(uuid) to authenticated;


-- ─── 3. Cheer page lock ─────────────────────────────────────
-- Update get_public_user_stats to include has_completed_goal
-- so the cheer page can gate access behind achievement.
-- Must drop first because return type is changing.

drop function if exists get_public_user_stats(uuid);

create or replace function get_public_user_stats(p_user_id uuid)
returns table(
  current_streak int,
  total_checkins int,
  active_goal_count int,
  latest_mood int,
  member_since date,
  has_completed_goal boolean
)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_streak int := 0;
  v_total int := 0;
  v_goals int := 0;
  v_mood int := 0;
  v_since date;
  v_has_completed boolean := false;
  v_today date := timezone('utc', now())::date;
  v_date date;
  v_rest_days int[];
  v_dow int;
begin
  -- Total checkins
  select count(*) into v_total
  from checkins where user_id = p_user_id;

  if v_total = 0 then
    return query select 0, 0, 0, 0, null::date, false;
    return;
  end if;

  -- Active goals
  select count(*) into v_goals
  from goals where user_id = p_user_id and active = true;

  -- Latest mood
  select mood into v_mood
  from checkins where user_id = p_user_id and mood is not null
  order by date desc limit 1;

  -- Member since
  select min(created_at)::date into v_since
  from checkins where user_id = p_user_id;

  -- Has completed goal
  select exists(
    select 1 from goals where user_id = p_user_id and completed_at is not null
  ) into v_has_completed;

  -- Rest days
  select rest_days into v_rest_days
  from user_settings where user_id = p_user_id;
  v_rest_days := coalesce(v_rest_days, '{}');

  -- Current streak
  v_date := v_today;
  loop
    v_dow := extract(dow from v_date)::int;
    if v_rest_days @> array[v_dow] then
      v_date := v_date - 1;
      continue;
    end if;

    if exists (select 1 from checkins where user_id = p_user_id and date = v_date) then
      v_streak := v_streak + 1;
      v_date := v_date - 1;
    else
      exit;
    end if;

    if v_today - v_date > 365 then exit; end if;
  end loop;

  return query select v_streak, v_total, v_goals, coalesce(v_mood, 0), v_since, v_has_completed;
end;
$$;

revoke all on function get_public_user_stats(uuid) from public;
grant execute on function get_public_user_stats(uuid) to anon, authenticated;
