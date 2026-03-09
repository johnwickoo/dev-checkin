-- ══════════════════════════════════════════════════════════════
-- Hardening round 2 + social bonding features
-- ══════════════════════════════════════════════════════════════


-- ─── 1. Guard email_sent and shame_email_sent ─────────────
-- Users could set email_sent=true via direct API to skip the
-- entire voting process. Create RPCs so only server logic can
-- set these flags.

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
       or new.email_sent is distinct from old.email_sent
       or new.shame_email_sent is distinct from old.shame_email_sent
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
       or new.email_sent is distinct from old.email_sent
       or new.shame_email_sent is distinct from old.shame_email_sent
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

-- RPC to mark excuse emails as sent (validates invites exist)
create or replace function mark_excuse_emails_sent(
  p_source_type text,
  p_source_id uuid
)
returns void
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  v_invite_count int;
begin
  if auth.uid() is null then
    raise exception 'Authentication required';
  end if;

  if p_source_type not in ('missed_day', 'deadline') then
    raise exception 'Invalid source_type';
  end if;

  -- Verify vote invites exist for this excuse
  select count(*) into v_invite_count
  from excuse_vote_invites
  where user_id = auth.uid()
    and source_type = p_source_type
    and source_id = p_source_id;

  if v_invite_count = 0 then
    raise exception 'Cannot mark emails sent without vote invites';
  end if;

  if p_source_type = 'missed_day' then
    update missed_days
    set email_sent = true
    where id = p_source_id and user_id = auth.uid();
  else
    update missed_goal_deadlines
    set email_sent = true
    where id = p_source_id and user_id = auth.uid();
  end if;
end;
$$;

-- RPC to mark shame emails as sent (validates verdict is rejected)
create or replace function mark_shame_email_sent(
  p_source_type text,
  p_source_id uuid
)
returns void
language plpgsql
security definer
set search_path = public, extensions
as $$
begin
  if auth.uid() is null then
    raise exception 'Authentication required';
  end if;

  if p_source_type not in ('missed_day', 'deadline') then
    raise exception 'Invalid source_type';
  end if;

  if p_source_type = 'missed_day' then
    -- Only allow if verdict is rejected
    if not exists (
      select 1 from missed_days
      where id = p_source_id
        and user_id = auth.uid()
        and verdict = 'rejected'
    ) then
      raise exception 'Cannot mark shame email sent without rejected verdict';
    end if;

    update missed_days
    set shame_email_sent = true
    where id = p_source_id and user_id = auth.uid();
  else
    if not exists (
      select 1 from missed_goal_deadlines
      where id = p_source_id
        and user_id = auth.uid()
        and verdict = 'rejected'
    ) then
      raise exception 'Cannot mark shame email sent without rejected verdict';
    end if;

    update missed_goal_deadlines
    set shame_email_sent = true
    where id = p_source_id and user_id = auth.uid();
  end if;
end;
$$;

revoke all on function mark_excuse_emails_sent(text, uuid) from public;
grant execute on function mark_excuse_emails_sent(text, uuid) to authenticated;

revoke all on function mark_shame_email_sent(text, uuid) from public;
grant execute on function mark_shame_email_sent(text, uuid) to authenticated;


-- ─── 2. Block deletions on goals, checkins, goal_progress ──
-- Users could DELETE goals (bypassing guard_goal_deactivation),
-- DELETE checkins (erasing bad days), or DELETE goal_progress
-- (removing failed verifications).

-- Goals: replace "for all" with specific SELECT/INSERT/UPDATE
drop policy if exists "Users manage own goals" on goals;
drop policy if exists "Users read own goals" on goals;
create policy "Users read own goals"
  on goals for select using (auth.uid() = user_id);
drop policy if exists "Users insert own goals" on goals;
create policy "Users insert own goals"
  on goals for insert with check (auth.uid() = user_id);
drop policy if exists "Users update own goals" on goals;
create policy "Users update own goals"
  on goals for update using (auth.uid() = user_id)
  with check (auth.uid() = user_id);
-- No DELETE policy = deletions blocked by RLS

-- Checkins: replace "for all" with SELECT/INSERT/UPDATE
drop policy if exists "Users manage own checkins" on checkins;
drop policy if exists "Users read own checkins" on checkins;
create policy "Users read own checkins"
  on checkins for select using (auth.uid() = user_id);
drop policy if exists "Users insert own checkins" on checkins;
create policy "Users insert own checkins"
  on checkins for insert with check (auth.uid() = user_id);
drop policy if exists "Users update own checkins" on checkins;
create policy "Users update own checkins"
  on checkins for update using (auth.uid() = user_id)
  with check (auth.uid() = user_id);
-- No DELETE policy = deletions blocked by RLS

-- Goal progress: replace "for all" with SELECT/INSERT/UPDATE
drop policy if exists "Users manage own goal_progress" on goal_progress;
drop policy if exists "Users read own goal_progress" on goal_progress;
create policy "Users read own goal_progress"
  on goal_progress for select
  using (exists (select 1 from checkins where checkins.id = goal_progress.checkin_id and checkins.user_id = auth.uid()));
drop policy if exists "Users insert own goal_progress" on goal_progress;
create policy "Users insert own goal_progress"
  on goal_progress for insert
  with check (exists (select 1 from checkins where checkins.id = goal_progress.checkin_id and checkins.user_id = auth.uid()));
drop policy if exists "Users update own goal_progress" on goal_progress;
create policy "Users update own goal_progress"
  on goal_progress for update
  using (exists (select 1 from checkins where checkins.id = goal_progress.checkin_id and checkins.user_id = auth.uid()))
  with check (exists (select 1 from checkins where checkins.id = goal_progress.checkin_id and checkins.user_id = auth.uid()));
-- No DELETE policy = deletions blocked by RLS


-- ─── 3. Server-side verification integrity ────────────────
-- Users could set verification_status='verified' directly via API.
-- This trigger validates that 'verified' is only set when proof
-- matches a recognized pattern (GitHub commit/PR/action).

create or replace function enforce_verification_integrity()
returns trigger
language plpgsql
as $$
begin
  if current_user = 'postgres' then return new; end if;

  -- Only enforce when verification_status is being set to 'verified'
  if new.verification_status = 'verified' then
    -- Validate proof matches a recognized auto-verify pattern
    if coalesce(new.proof_url, '') ~ '^https?://(www\.)?github\.com/.+'
       and (
         new.proof_url ~ '/commit/[0-9a-f]{7,40}($|[/?#])'
         or new.proof_url ~ '/pull/[0-9]+($|[/?#])'
         or new.proof_url ~ '/actions/runs/[0-9]+($|[/?#])'
       ) then
      -- Valid GitHub proof pattern, allow verified status
      null;
    else
      -- Not a valid auto-verify pattern — override to pending
      new.verification_status := 'pending';
      new.verification_reason := coalesce(
        nullif(trim(new.verification_reason), ''),
        'Pending manual review'
      );
      new.verified_by := null;
      new.verified_at := null;
    end if;
  end if;

  return new;
end;
$$;

drop trigger if exists trg_enforce_verification_integrity on goal_progress;
create trigger trg_enforce_verification_integrity
  before insert or update on goal_progress
  for each row execute function enforce_verification_integrity();


-- ─── 4. Encouragements (social bonding) ───────────────────
-- Partners can send positive messages, not just vote and punish.
-- These show on the user's check-in page to build connection.

create table if not exists encouragements (
  id uuid default gen_random_uuid() primary key,
  user_id uuid references auth.users(id) on delete cascade not null,
  sender_email text not null,
  sender_name text,
  message text not null check (length(trim(message)) between 2 and 500),
  created_at timestamptz default now()
);

alter table encouragements enable row level security;

-- Owner can read their own encouragements
drop policy if exists "Users read own encouragements" on encouragements;
create policy "Users read own encouragements"
  on encouragements for select using (auth.uid() = user_id);

-- Anyone can insert (public page, like punishment suggestions)
drop policy if exists "Anyone can insert encouragements" on encouragements;
create policy "Anyone can insert encouragements"
  on encouragements for insert with check (true);

-- No UPDATE or DELETE — encouragements are permanent

-- Rate-limited submission via RPC
create or replace function submit_encouragement(
  p_user_id uuid,
  p_email text,
  p_name text,
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
  v_today_count int;
  v_new_id uuid;
begin
  v_email := lower(trim(coalesce(p_email, '')));
  v_message := trim(coalesce(p_message, ''));

  if v_email = '' or v_email not like '%@%' then
    return query select 'invalid_email'::text, null::uuid;
    return;
  end if;

  if length(v_message) < 2 or length(v_message) > 500 then
    return query select 'invalid_message'::text, null::uuid;
    return;
  end if;

  -- Rate limit: max 10 per email per user per day
  select count(*) into v_today_count
  from encouragements
  where user_id = p_user_id
    and sender_email = v_email
    and created_at >= now() - interval '1 day';

  if v_today_count >= 10 then
    return query select 'rate_limited'::text, null::uuid;
    return;
  end if;

  insert into encouragements (user_id, sender_email, sender_name, message)
  values (p_user_id, v_email, nullif(trim(coalesce(p_name, '')), ''), v_message)
  returning encouragements.id into v_new_id;

  return query select 'ok'::text, v_new_id;
end;
$$;

revoke all on function submit_encouragement(uuid, text, text, text) from public;
grant execute on function submit_encouragement(uuid, text, text, text) to anon, authenticated;
