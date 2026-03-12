-- Allow custom free-text punishments from partners
-- Remove hardcoded punishment_choice constraints

-- 1. Drop hardcoded CHECK constraints
alter table excuse_votes drop constraint if exists excuse_votes_punishment_choice_check;
alter table missed_days drop constraint if exists missed_days_selected_punishment_check;
alter table missed_goal_deadlines drop constraint if exists missed_goal_deadlines_selected_punishment_check;

-- 2. Widen punishment_choice column — allow any text up to 200 chars
alter table excuse_votes drop constraint if exists excuse_votes_punishment_choice_length;
alter table excuse_votes
  add constraint excuse_votes_punishment_choice_length
  check (punishment_choice is null or char_length(punishment_choice) between 3 and 200);

-- 3. Update cast_excuse_vote to accept free-text punishment
drop function if exists cast_excuse_vote(text, text);

create or replace function cast_excuse_vote(p_token text, p_vote text)
returns table(
  status text,
  vote text,
  excuse_id text,
  missed_date text,
  excuse_text text,
  verdict text,
  selected_punishment text
)
language plpgsql
security definer
set search_path = public, extensions
as $$
#variable_conflict use_column
declare
  v_hash text;
  v_vote_input text;
  v_vote_normalized text;
  v_punishment_choice text;
  v_invite excuse_vote_invites%rowtype;
  v_existing_vote text;
  v_final_vote text;
  v_verdict text;
  v_selected_punishment text;
begin
  v_vote_input := trim(coalesce(p_vote, ''));

  if lower(v_vote_input) = 'accept' then
    v_vote_normalized := 'accept';
    v_punishment_choice := null;
  elsif lower(v_vote_input) = 'reject' then
    v_vote_normalized := 'reject';
    v_punishment_choice := null;
  elsif lower(v_vote_input) like 'reject:%' then
    v_vote_normalized := 'reject';
    -- Everything after "reject:" is the custom punishment text
    v_punishment_choice := trim(substring(p_vote from 8));
    if char_length(v_punishment_choice) < 3 or char_length(v_punishment_choice) > 200 then
      return query select 'invalid_vote', null::text, null::text, null::text, null::text, null::text, null::text;
      return;
    end if;
  else
    return query select 'invalid_vote', null::text, null::text, null::text, null::text, null::text, null::text;
    return;
  end if;

  if p_token is null or length(trim(p_token)) < 20 then
    return query select 'invalid_token', null::text, null::text, null::text, null::text, null::text, null::text;
    return;
  end if;

  v_hash := encode(digest(trim(p_token), 'sha256'), 'hex');

  select * into v_invite
  from excuse_vote_invites
  where token_hash = v_hash
  limit 1;

  if not found then
    return query select 'invalid_token', null::text, null::text, null::text, null::text, null::text, null::text;
    return;
  end if;

  if v_invite.expires_at <= now() then
    return query select 'expired', null::text, v_invite.excuse_id, v_invite.missed_date, v_invite.excuse_text, null::text, null::text;
    return;
  end if;

  select ev.vote into v_existing_vote
  from excuse_votes ev
  where ev.excuse_id = v_invite.excuse_id
    and ev.voter_email = v_invite.voter_email
    and ev.source_type = v_invite.source_type
    and ev.source_id = v_invite.source_id
  limit 1;

  if v_existing_vote is not null then
    update excuse_vote_invites
    set used_at = coalesce(used_at, now())
    where id = v_invite.id;

    return query select 'already_voted', v_existing_vote, v_invite.excuse_id, v_invite.missed_date, v_invite.excuse_text, null::text, null::text;
    return;
  end if;

  insert into excuse_votes (
    owner_user_id,
    source_type,
    source_id,
    excuse_id,
    missed_date,
    voter_email,
    vote,
    excuse_text,
    punishment_choice
  )
  values (
    v_invite.user_id,
    v_invite.source_type,
    v_invite.source_id,
    v_invite.excuse_id,
    v_invite.missed_date,
    v_invite.voter_email,
    v_vote_normalized,
    v_invite.excuse_text,
    case when v_vote_normalized = 'reject' then v_punishment_choice else null end
  )
  on conflict on constraint excuse_votes_excuse_id_voter_email_key
  do nothing;

  update excuse_vote_invites
  set used_at = now()
  where id = v_invite.id;

  select ev.vote into v_final_vote
  from excuse_votes ev
  where ev.excuse_id = v_invite.excuse_id
    and ev.voter_email = v_invite.voter_email
    and ev.source_type = v_invite.source_type
    and ev.source_id = v_invite.source_id
  limit 1;

  v_verdict := resolve_excuse_verdict_internal(v_invite.source_type, v_invite.source_id);

  if v_verdict = 'rejected' then
    if v_invite.source_type = 'missed_day' then
      select selected_punishment into v_selected_punishment
      from missed_days
      where id = v_invite.source_id;
    else
      select selected_punishment into v_selected_punishment
      from missed_goal_deadlines
      where id = v_invite.source_id;
    end if;
  else
    v_selected_punishment := null;
  end if;

  return query select 'voted', coalesce(v_final_vote, v_vote_normalized), v_invite.excuse_id, v_invite.missed_date, v_invite.excuse_text, v_verdict, v_selected_punishment;
end;
$$;

revoke all on function cast_excuse_vote(text, text) from public;
grant execute on function cast_excuse_vote(text, text) to anon, authenticated;

-- 4. Update resolve_excuse_verdict_internal:
--    - Random pick from custom punishments submitted by rejecting partners
--    - For even partner counts (tie), FCFS: first to reach floor(count/2)+1 wins
create or replace function resolve_excuse_verdict_internal(p_source_type text, p_source_id uuid)
returns text
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  v_required int := 2;
  v_partner_count int := 0;
  v_majority int := 2;
  v_accepts int := 0;
  v_rejects int := 0;
  v_total int := 0;
  v_verdict text;
  v_selected_punishment text;
  v_selected_punishment_votes int := 0;
  v_day missed_days%rowtype;
  v_deadline missed_goal_deadlines%rowtype;
  v_fallback_punishments text[] := ARRAY[
    'Do a focused 2-hour deep work block and share proof',
    'No social media for 24 hours',
    'Donate $20 and share receipt'
  ];
begin
  if p_source_type = 'missed_day' then
    select * into v_day from missed_days where id = p_source_id for update;
    if not found then return null; end if;
    if v_day.verdict is not null then return v_day.verdict; end if;

    v_required := greatest(coalesce(v_day.required_votes, 2), 1);
    v_partner_count := greatest(coalesce(v_day.partner_count_snapshot, 0), v_required, 1);
    v_majority := floor(v_partner_count / 2.0)::int + 1;

    select
      count(*) filter (where vote = 'accept'),
      count(*) filter (where vote = 'reject'),
      count(*)
    into v_accepts, v_rejects, v_total
    from excuse_votes
    where source_type = 'missed_day' and source_id = p_source_id;

    -- FCFS: first side to reach majority wins
    if v_accepts >= v_majority then
      v_verdict := 'accepted';
    elsif v_rejects >= v_majority then
      v_verdict := 'rejected';
    elsif v_total < v_partner_count then
      return null; -- still waiting for votes
    else
      -- All voted, tie → rejected (accountability wins)
      v_verdict := 'rejected';
    end if;

    if v_verdict = 'rejected' then
      -- Pick randomly from custom punishments submitted by rejecting partners
      select ev.punishment_choice into v_selected_punishment
      from excuse_votes ev
      where ev.source_type = 'missed_day'
        and ev.source_id = p_source_id
        and ev.vote = 'reject'
        and ev.punishment_choice is not null
        and char_length(ev.punishment_choice) >= 3
      order by random()
      limit 1;

      -- If no custom punishments were submitted, pick a random default
      if v_selected_punishment is null then
        v_selected_punishment := v_fallback_punishments[1 + floor(random() * array_length(v_fallback_punishments, 1))::int];
      end if;
      v_selected_punishment_votes := v_rejects;
    else
      v_selected_punishment := null;
      v_selected_punishment_votes := 0;
    end if;

    update missed_days
    set verdict = v_verdict,
        vote_accepts = v_accepts,
        vote_rejects = v_rejects,
        vote_total = v_total,
        selected_punishment = v_selected_punishment,
        selected_punishment_votes = coalesce(v_selected_punishment_votes, 0)
    where id = p_source_id;

    return v_verdict;
  end if;

  if p_source_type = 'deadline' then
    select * into v_deadline from missed_goal_deadlines where id = p_source_id for update;
    if not found then return null; end if;
    if v_deadline.verdict is not null then return v_deadline.verdict; end if;

    v_required := greatest(coalesce(v_deadline.required_votes, 2), 1);
    v_partner_count := greatest(coalesce(v_deadline.partner_count_snapshot, 0), v_required, 1);
    v_majority := floor(v_partner_count / 2.0)::int + 1;

    select
      count(*) filter (where vote = 'accept'),
      count(*) filter (where vote = 'reject'),
      count(*)
    into v_accepts, v_rejects, v_total
    from excuse_votes
    where source_type = 'deadline' and source_id = p_source_id;

    if v_accepts >= v_majority then
      v_verdict := 'accepted';
    elsif v_rejects >= v_majority then
      v_verdict := 'rejected';
    elsif v_total < v_partner_count then
      return null;
    else
      v_verdict := 'rejected';
    end if;

    if v_verdict = 'rejected' then
      select ev.punishment_choice into v_selected_punishment
      from excuse_votes ev
      where ev.source_type = 'deadline'
        and ev.source_id = p_source_id
        and ev.vote = 'reject'
        and ev.punishment_choice is not null
        and char_length(ev.punishment_choice) >= 3
      order by random()
      limit 1;

      if v_selected_punishment is null then
        v_selected_punishment := v_fallback_punishments[1 + floor(random() * array_length(v_fallback_punishments, 1))::int];
      end if;
      v_selected_punishment_votes := v_rejects;
    else
      v_selected_punishment := null;
      v_selected_punishment_votes := 0;
    end if;

    update missed_goal_deadlines
    set verdict = v_verdict,
        vote_accepts = v_accepts,
        vote_rejects = v_rejects,
        vote_total = v_total,
        selected_punishment = v_selected_punishment,
        selected_punishment_votes = coalesce(v_selected_punishment_votes, 0)
    where id = p_source_id;

    if v_verdict = 'accepted'
       and v_deadline.requested_deadline is not null
       and v_deadline.requested_deadline > v_deadline.deadline then
      update goals
      set deadline = v_deadline.requested_deadline
      where id = v_deadline.goal_id
        and user_id = v_deadline.user_id
        and active = true;

      update missed_goal_deadlines
      set extension_applied = true
      where id = p_source_id;
    end if;

    return v_verdict;
  end if;

  return null;
end;
$$;

-- 5. Update pick_punishment_description to handle free-text punishments
create or replace function pick_punishment_description(
  p_user_id uuid,
  p_fallback_choice text
)
returns text
language plpgsql
security definer
as $$
declare
  v_custom text;
  v_fallback_punishments text[] := ARRAY[
    'Do a focused 2-hour deep work block and share proof',
    'No social media for 24 hours',
    'Donate $20 and share receipt'
  ];
  v_legacy_labels jsonb := '{
    "deep_work_2h": "Do a focused 2-hour deep work block and share proof",
    "no_social_24h": "No social media for 24 hours",
    "donate_20": "Donate $20 and share receipt"
  }'::jsonb;
begin
  -- If the fallback is already free text (not a legacy key), use it directly
  if p_fallback_choice is not null
     and char_length(p_fallback_choice) >= 3
     and not (v_legacy_labels ? p_fallback_choice) then
    return p_fallback_choice;
  end if;

  -- Try custom suggestions from the punishment_suggestions table
  select suggestion into v_custom
  from punishment_suggestions
  where user_id = p_user_id
  order by random()
  limit 1;

  if v_custom is not null then
    return v_custom;
  end if;

  -- Fall back to legacy label or random default
  if p_fallback_choice is not null and (v_legacy_labels ? p_fallback_choice) then
    return v_legacy_labels ->> p_fallback_choice;
  end if;

  return v_fallback_punishments[1 + floor(random() * array_length(v_fallback_punishments, 1))::int];
end;
$$;
