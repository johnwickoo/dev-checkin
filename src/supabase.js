import { createClient } from '@supabase/supabase-js'

const SUPABASE_URL      = import.meta.env.VITE_SUPABASE_URL
const SUPABASE_ANON_KEY = import.meta.env.VITE_SUPABASE_ANON_KEY

export const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY)

/*
  Run this SQL in your Supabase SQL Editor to set up all tables and security.

  create extension if not exists pgcrypto;

  -- ══════════════════════════════════════════════════════════════
  -- 1. Goals
  -- ══════════════════════════════════════════════════════════════
  create table if not exists goals (
    id uuid default gen_random_uuid() primary key,
    user_id uuid references auth.users(id) on delete cascade not null,
    title text not null,
    deadline date,
    active boolean default true,
    completed_at timestamptz,
    created_at timestamptz default now()
  );

  alter table goals enable row level security;
  drop policy if exists "Users manage own goals" on goals;
  create policy "Users manage own goals"
    on goals for all using (auth.uid() = user_id)
    with check (auth.uid() = user_id);

  -- ══════════════════════════════════════════════════════════════
  -- 2. Check-ins
  -- ══════════════════════════════════════════════════════════════
  create table if not exists checkins (
    id uuid default gen_random_uuid() primary key,
    user_id uuid references auth.users(id) on delete cascade not null,
    date date not null,
    mood int check (mood between 1 and 5),
    learned text,
    built text,
    built_link text,
    proof_url text,
    proof_image_path text,
    created_at timestamptz default now(),
    unique(user_id, date)
  );

  alter table checkins enable row level security;
  drop policy if exists "Users manage own checkins" on checkins;
  create policy "Users manage own checkins"
    on checkins for all using (auth.uid() = user_id)
    with check (auth.uid() = user_id);

  create or replace function enforce_checkin_date_window()
  returns trigger
  language plpgsql
  as $$
  declare
    server_date date := timezone('utc', now())::date;
  begin
    if tg_op = 'INSERT' then
      if new.date < server_date - 1 or new.date > server_date then
        raise exception 'Check-in date must be today or yesterday (UTC)';
      end if;
    elsif tg_op = 'UPDATE' then
      if new.date <> old.date then
        raise exception 'Check-in date is immutable';
      end if;
      if old.date <> server_date and old.date <> server_date - 1 then
        raise exception 'Only recent check-ins can be edited';
      end if;
    end if;

    return new;
  end;
  $$;

  drop trigger if exists trg_enforce_checkin_date_window on checkins;
  create trigger trg_enforce_checkin_date_window
    before insert or update on checkins
    for each row execute function enforce_checkin_date_window();

  -- ══════════════════════════════════════════════════════════════
  -- 3. Goal progress (per check-in)
  -- ══════════════════════════════════════════════════════════════
  create table if not exists goal_progress (
    id uuid default gen_random_uuid() primary key,
    checkin_id uuid references checkins(id) on delete cascade not null,
    goal_id uuid references goals(id) on delete cascade not null,
    completed boolean default false,
    proof_url text,
    proof_image_path text,
    verification_status text check (verification_status in ('pending', 'verified', 'failed', 'challenged')),
    verification_reason text,
    verified_at timestamptz,
    verified_by text,
    audit_required boolean default false,
    challenge_window_ends_at timestamptz,
    unique(checkin_id, goal_id)
  );

  alter table goal_progress enable row level security;
  drop policy if exists "Users manage own goal_progress" on goal_progress;
  create policy "Users manage own goal_progress"
    on goal_progress for all
    using (
      exists (select 1 from checkins where checkins.id = goal_progress.checkin_id and checkins.user_id = auth.uid())
    )
    with check (
      exists (select 1 from checkins where checkins.id = goal_progress.checkin_id and checkins.user_id = auth.uid())
    );

  -- ══════════════════════════════════════════════════════════════
  -- 4. Missed days
  -- ══════════════════════════════════════════════════════════════
  create table if not exists missed_days (
    id uuid default gen_random_uuid() primary key,
    user_id uuid references auth.users(id) on delete cascade not null,
    date date not null,
    excuse text not null,
    was_avoidable boolean,
    excuse_id text,
    required_votes int default 2,
    partner_count_snapshot int default 0,
    email_sent boolean default false,
    verdict text check (verdict in ('accepted', 'rejected')),
    vote_accepts int default 0,
    vote_rejects int default 0,
    vote_total int default 0,
    shame_email_sent boolean default false,
    punishment_acknowledged boolean default false,
    created_at timestamptz default now(),
    unique(user_id, date)
  );

  alter table missed_days enable row level security;
  drop policy if exists "Users read own missed_days" on missed_days;
  create policy "Users read own missed_days"
    on missed_days for select using (auth.uid() = user_id);
  drop policy if exists "Users insert own missed_days" on missed_days;
  create policy "Users insert own missed_days"
    on missed_days for insert with check (auth.uid() = user_id);
  drop policy if exists "Users update own missed_days" on missed_days;
  create policy "Users update own missed_days"
    on missed_days for update using (auth.uid() = user_id)
    with check (auth.uid() = user_id);

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
         or new.created_at is distinct from old.created_at then
        raise exception 'Direct outcome edits are blocked';
      end if;
    end if;
    return new;
  end;
  $$;

  drop trigger if exists trg_guard_missed_days_update on missed_days;
  create trigger trg_guard_missed_days_update
    before update on missed_days
    for each row execute function guard_missed_days_update();

  -- ══════════════════════════════════════════════════════════════
  -- 5. Missed goal deadlines
  -- ══════════════════════════════════════════════════════════════
  create table if not exists missed_goal_deadlines (
    id uuid default gen_random_uuid() primary key,
    user_id uuid references auth.users(id) on delete cascade not null,
    goal_id uuid references goals(id) on delete cascade not null,
    deadline date not null,
    excuse text not null,
    requested_deadline date,
    extension_applied boolean default false,
    was_avoidable boolean,
    excuse_id text,
    required_votes int default 2,
    partner_count_snapshot int default 0,
    email_sent boolean default false,
    verdict text check (verdict in ('accepted', 'rejected')),
    vote_accepts int default 0,
    vote_rejects int default 0,
    vote_total int default 0,
    shame_email_sent boolean default false,
    punishment_acknowledged boolean default false,
    created_at timestamptz default now(),
    unique(user_id, goal_id, deadline)
  );

  alter table missed_goal_deadlines enable row level security;
  drop policy if exists "Users read own missed_goal_deadlines" on missed_goal_deadlines;
  create policy "Users read own missed_goal_deadlines"
    on missed_goal_deadlines for select using (auth.uid() = user_id);
  drop policy if exists "Users insert own missed_goal_deadlines" on missed_goal_deadlines;
  create policy "Users insert own missed_goal_deadlines"
    on missed_goal_deadlines for insert with check (auth.uid() = user_id);
  drop policy if exists "Users update own missed_goal_deadlines" on missed_goal_deadlines;
  create policy "Users update own missed_goal_deadlines"
    on missed_goal_deadlines for update using (auth.uid() = user_id)
    with check (auth.uid() = user_id);

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
         or new.created_at is distinct from old.created_at then
        raise exception 'Direct outcome edits are blocked';
      end if;
    end if;
    return new;
  end;
  $$;

  drop trigger if exists trg_guard_missed_goal_deadlines_update on missed_goal_deadlines;
  create trigger trg_guard_missed_goal_deadlines_update
    before update on missed_goal_deadlines
    for each row execute function guard_missed_goal_deadlines_update();

  -- ══════════════════════════════════════════════════════════════
  -- 6. Accountability partners
  -- ══════════════════════════════════════════════════════════════
  create table if not exists accountability_partners (
    id uuid default gen_random_uuid() primary key,
    user_id uuid references auth.users(id) on delete cascade not null,
    email text not null,
    created_at timestamptz default now(),
    unique(user_id, email)
  );

  alter table accountability_partners enable row level security;
  drop policy if exists "Users manage own partners" on accountability_partners;
  create policy "Users manage own partners"
    on accountability_partners for all using (auth.uid() = user_id)
    with check (auth.uid() = user_id);

  create or replace function enforce_partner_floor()
  returns trigger
  language plpgsql
  as $$
  declare
    current_count int;
  begin
    if current_user <> 'postgres' then
      select count(*) into current_count
      from accountability_partners
      where user_id = old.user_id;

      if current_count <= 3 then
        raise exception 'At least 3 accountability partners are required';
      end if;
    end if;

    return old;
  end;
  $$;

  drop trigger if exists trg_enforce_partner_floor on accountability_partners;
  create trigger trg_enforce_partner_floor
    before delete on accountability_partners
    for each row execute function enforce_partner_floor();

  -- ══════════════════════════════════════════════════════════════
  -- 7. Excuse votes (owner-readable only, cast via RPC)
  -- ══════════════════════════════════════════════════════════════
  create table if not exists excuse_votes (
    id uuid default gen_random_uuid() primary key,
    owner_user_id uuid references auth.users(id) on delete cascade not null,
    source_type text not null check (source_type in ('missed_day', 'deadline')),
    source_id uuid not null,
    excuse_id text not null,
    missed_date text not null,
    voter_email text not null,
    vote text not null check (vote in ('accept', 'reject')),
    excuse_text text,
    created_at timestamptz default now(),
    unique (excuse_id, voter_email)
  );

  -- Backfill schema for older installs created before owner/source columns existed.
  alter table excuse_votes add column if not exists owner_user_id uuid references auth.users(id) on delete cascade;
  alter table excuse_votes add column if not exists source_type text check (source_type in ('missed_day', 'deadline'));
  alter table excuse_votes add column if not exists source_id uuid;

  alter table excuse_votes enable row level security;
  drop policy if exists "Allow anonymous inserts" on excuse_votes;
  drop policy if exists "Allow anonymous reads" on excuse_votes;
  drop policy if exists "Owners read own excuse_votes" on excuse_votes;
  create policy "Owners read own excuse_votes"
    on excuse_votes for select
    using (auth.uid() = owner_user_id);

  -- ══════════════════════════════════════════════════════════════
  -- 8. Vote invites (tokenized links)
  -- ══════════════════════════════════════════════════════════════
  create table if not exists excuse_vote_invites (
    id uuid default gen_random_uuid() primary key,
    user_id uuid references auth.users(id) on delete cascade not null,
    source_type text not null check (source_type in ('missed_day', 'deadline')),
    source_id uuid not null,
    excuse_id text not null,
    voter_email text not null,
    missed_date text not null,
    excuse_text text,
    token_hash text not null unique,
    expires_at timestamptz not null,
    used_at timestamptz,
    created_at timestamptz default now(),
    unique (excuse_id, voter_email)
  );

  alter table excuse_vote_invites enable row level security;
  drop policy if exists "Users read own vote invites" on excuse_vote_invites;
  create policy "Users read own vote invites"
    on excuse_vote_invites for select
    using (auth.uid() = user_id);

  -- ══════════════════════════════════════════════════════════════
  -- 9. Voting RPC (secure)
  -- ══════════════════════════════════════════════════════════════
  create or replace function resolve_excuse_verdict_internal(p_source_type text, p_source_id uuid)
  returns text
  language plpgsql
  security definer
  set search_path = public, extensions
  as $$
  declare
    v_required int := 2;
    v_accepts int := 0;
    v_rejects int := 0;
    v_total int := 0;
    v_verdict text;
    v_day missed_days%rowtype;
    v_deadline missed_goal_deadlines%rowtype;
  begin
    if p_source_type = 'missed_day' then
      select * into v_day from missed_days where id = p_source_id for update;
      if not found then return null; end if;
      if v_day.verdict is not null then return v_day.verdict; end if;

      v_required := greatest(coalesce(v_day.required_votes, 2), 1);

      select
        count(*) filter (where vote = 'accept'),
        count(*) filter (where vote = 'reject'),
        count(*)
      into v_accepts, v_rejects, v_total
      from excuse_votes
      where source_type = 'missed_day' and source_id = p_source_id;

      if v_total < v_required then return null; end if;

      v_verdict := case when v_rejects > v_accepts then 'rejected' else 'accepted' end;
      update missed_days
      set verdict = v_verdict,
          vote_accepts = v_accepts,
          vote_rejects = v_rejects,
          vote_total = v_total
      where id = p_source_id;

      return v_verdict;
    end if;

    if p_source_type = 'deadline' then
      select * into v_deadline from missed_goal_deadlines where id = p_source_id for update;
      if not found then return null; end if;
      if v_deadline.verdict is not null then return v_deadline.verdict; end if;

      v_required := greatest(coalesce(v_deadline.required_votes, 2), 1);

      select
        count(*) filter (where vote = 'accept'),
        count(*) filter (where vote = 'reject'),
        count(*)
      into v_accepts, v_rejects, v_total
      from excuse_votes
      where source_type = 'deadline' and source_id = p_source_id;

      if v_total < v_required then return null; end if;

      v_verdict := case when v_rejects > v_accepts then 'rejected' else 'accepted' end;
      update missed_goal_deadlines
      set verdict = v_verdict,
          vote_accepts = v_accepts,
          vote_rejects = v_rejects,
          vote_total = v_total
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

  create or replace function create_excuse_vote_invites(
    p_source_type text,
    p_source_id uuid,
    p_excuse_id text,
    p_missed_date text,
    p_excuse_text text,
    p_voter_emails text[]
  )
  returns table(voter_email text, token text)
  language plpgsql
  security definer
  set search_path = public, extensions
  as $$
  #variable_conflict use_column
  declare
    v_email text;
    v_norm_email text;
    v_token text;
    v_hash text;
    v_day missed_days%rowtype;
    v_deadline missed_goal_deadlines%rowtype;
  begin
    if auth.uid() is null then
      raise exception 'Authentication required';
    end if;

    if p_source_type not in ('missed_day', 'deadline') then
      raise exception 'Invalid source_type';
    end if;

    if coalesce(array_length(p_voter_emails, 1), 0) = 0 then
      raise exception 'No voter emails supplied';
    end if;

    if p_source_type = 'missed_day' then
      select * into v_day
      from missed_days
      where id = p_source_id and user_id = auth.uid();
      if not found then raise exception 'Missed day record not found'; end if;
      if v_day.excuse_id is distinct from p_excuse_id then raise exception 'Excuse/source mismatch'; end if;
    else
      select * into v_deadline
      from missed_goal_deadlines
      where id = p_source_id and user_id = auth.uid();
      if not found then raise exception 'Missed deadline record not found'; end if;
      if v_deadline.excuse_id is distinct from p_excuse_id then raise exception 'Excuse/source mismatch'; end if;
    end if;

    foreach v_email in array p_voter_emails loop
      v_norm_email := lower(trim(v_email));
      if v_norm_email is null or v_norm_email = '' then
        continue;
      end if;

      v_token := encode(gen_random_bytes(24), 'hex');
      v_hash := encode(digest(v_token, 'sha256'), 'hex');

      insert into excuse_vote_invites (
        user_id,
        source_type,
        source_id,
        excuse_id,
        voter_email,
        missed_date,
        excuse_text,
        token_hash,
        expires_at,
        used_at
      )
      values (
        auth.uid(),
        p_source_type,
        p_source_id,
        p_excuse_id,
        v_norm_email,
        p_missed_date,
        p_excuse_text,
        v_hash,
        now() + interval '14 days',
        null
      )
      on conflict (excuse_id, voter_email)
      do update set
        source_type = excluded.source_type,
        source_id = excluded.source_id,
        missed_date = excluded.missed_date,
        excuse_text = excluded.excuse_text,
        token_hash = excluded.token_hash,
        expires_at = excluded.expires_at,
        used_at = null,
        created_at = now();

      voter_email := v_norm_email;
      token := v_token;
      return next;
    end loop;
  end;
  $$;

  create or replace function get_excuse_vote_context(p_token text)
  returns table(
    status text,
    excuse_id text,
    missed_date text,
    excuse_text text,
    existing_vote text,
    expires_at timestamptz,
    used_at timestamptz
  )
  language plpgsql
  security definer
  set search_path = public, extensions
  as $$
  declare
    v_hash text;
    v_invite excuse_vote_invites%rowtype;
    v_existing_vote text;
  begin
    if p_token is null or length(trim(p_token)) < 20 then
      return query select 'invalid_token', null::text, null::text, null::text, null::text, null::timestamptz, null::timestamptz;
      return;
    end if;

    v_hash := encode(digest(trim(p_token), 'sha256'), 'hex');

    select * into v_invite
    from excuse_vote_invites
    where token_hash = v_hash
    limit 1;

    if not found then
      return query select 'invalid_token', null::text, null::text, null::text, null::text, null::timestamptz, null::timestamptz;
      return;
    end if;

    select vote into v_existing_vote
    from excuse_votes
    where excuse_id = v_invite.excuse_id
      and voter_email = v_invite.voter_email
      and source_type = v_invite.source_type
      and source_id = v_invite.source_id
    limit 1;

    if v_invite.expires_at <= now() then
      return query select 'expired', v_invite.excuse_id, v_invite.missed_date, v_invite.excuse_text, v_existing_vote, v_invite.expires_at, v_invite.used_at;
    elsif v_existing_vote is not null or v_invite.used_at is not null then
      return query select 'already_voted', v_invite.excuse_id, v_invite.missed_date, v_invite.excuse_text, coalesce(v_existing_vote, 'accept'), v_invite.expires_at, v_invite.used_at;
    else
      return query select 'ready', v_invite.excuse_id, v_invite.missed_date, v_invite.excuse_text, null::text, v_invite.expires_at, v_invite.used_at;
    end if;
  end;
  $$;

  create or replace function cast_excuse_vote(p_token text, p_vote text)
  returns table(
    status text,
    vote text,
    excuse_id text,
    missed_date text,
    excuse_text text,
    verdict text
  )
  language plpgsql
  security definer
  set search_path = public, extensions
  as $$
  declare
    v_hash text;
    v_invite excuse_vote_invites%rowtype;
    v_existing_vote text;
    v_final_vote text;
    v_verdict text;
  begin
    if p_vote not in ('accept', 'reject') then
      return query select 'invalid_vote', null::text, null::text, null::text, null::text, null::text;
      return;
    end if;

    if p_token is null or length(trim(p_token)) < 20 then
      return query select 'invalid_token', null::text, null::text, null::text, null::text, null::text;
      return;
    end if;

    v_hash := encode(digest(trim(p_token), 'sha256'), 'hex');

    select * into v_invite
    from excuse_vote_invites
    where token_hash = v_hash
    limit 1;

    if not found then
      return query select 'invalid_token', null::text, null::text, null::text, null::text, null::text;
      return;
    end if;

    if v_invite.expires_at <= now() then
      return query select 'expired', null::text, v_invite.excuse_id, v_invite.missed_date, v_invite.excuse_text, null::text;
      return;
    end if;

    select vote into v_existing_vote
    from excuse_votes
    where excuse_id = v_invite.excuse_id
      and voter_email = v_invite.voter_email
      and source_type = v_invite.source_type
      and source_id = v_invite.source_id
    limit 1;

    if v_existing_vote is not null then
      update excuse_vote_invites
      set used_at = coalesce(used_at, now())
      where id = v_invite.id;

      return query select 'already_voted', v_existing_vote, v_invite.excuse_id, v_invite.missed_date, v_invite.excuse_text, null::text;
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
      excuse_text
    )
    values (
      v_invite.user_id,
      v_invite.source_type,
      v_invite.source_id,
      v_invite.excuse_id,
      v_invite.missed_date,
      v_invite.voter_email,
      p_vote,
      v_invite.excuse_text
    )
    on conflict (excuse_id, voter_email)
    do nothing;

    update excuse_vote_invites
    set used_at = now()
    where id = v_invite.id;

    select vote into v_final_vote
    from excuse_votes
    where excuse_id = v_invite.excuse_id
      and voter_email = v_invite.voter_email
      and source_type = v_invite.source_type
      and source_id = v_invite.source_id
    limit 1;

    v_verdict := resolve_excuse_verdict_internal(v_invite.source_type, v_invite.source_id);

    return query select 'voted', coalesce(v_final_vote, p_vote), v_invite.excuse_id, v_invite.missed_date, v_invite.excuse_text, v_verdict;
  end;
  $$;

  revoke all on function resolve_excuse_verdict_internal(text, uuid) from public;
  revoke all on function create_excuse_vote_invites(text, uuid, text, text, text, text[]) from public;
  revoke all on function get_excuse_vote_context(text) from public;
  revoke all on function cast_excuse_vote(text, text) from public;

  grant execute on function create_excuse_vote_invites(text, uuid, text, text, text, text[]) to authenticated;
  grant execute on function get_excuse_vote_context(text) to anon, authenticated;
  grant execute on function cast_excuse_vote(text, text) to anon, authenticated;

  -- ══════════════════════════════════════════════════════════════
  -- 10. Proof verification audit log
  -- ══════════════════════════════════════════════════════════════
  create table if not exists proof_verifications (
    id uuid default gen_random_uuid() primary key,
    user_id uuid references auth.users(id) on delete cascade not null,
    checkin_id uuid references checkins(id) on delete cascade not null,
    goal_id uuid references goals(id) on delete cascade not null,
    verification_status text not null check (verification_status in ('pending', 'verified', 'failed', 'challenged')),
    verification_reason text,
    proof_url text,
    proof_image_path text,
    source text,
    audit_required boolean default false,
    created_at timestamptz default now()
  );

  alter table proof_verifications enable row level security;
  drop policy if exists "Users read own proof_verifications" on proof_verifications;
  create policy "Users read own proof_verifications"
    on proof_verifications for select using (auth.uid() = user_id);
  drop policy if exists "Users insert own proof_verifications" on proof_verifications;
  create policy "Users insert own proof_verifications"
    on proof_verifications for insert with check (auth.uid() = user_id);

  -- ══════════════════════════════════════════════════════════════
  -- 11. Storage bucket for proof images
  -- ══════════════════════════════════════════════════════════════
  insert into storage.buckets (id, name, public)
  values ('proof-images', 'proof-images', true)
  on conflict (id) do nothing;

  drop policy if exists "Users upload own proof images" on storage.objects;
  create policy "Users upload own proof images"
    on storage.objects for insert
    with check (bucket_id = 'proof-images' and auth.role() = 'authenticated');

  drop policy if exists "Public read proof images" on storage.objects;
  create policy "Public read proof images"
    on storage.objects for select
    using (bucket_id = 'proof-images');

  drop policy if exists "Users delete own proof images" on storage.objects;
  create policy "Users delete own proof images"
    on storage.objects for delete
    using (bucket_id = 'proof-images' and auth.uid()::text = (storage.foldername(name))[1]);

  -- ══════════════════════════════════════════════════════════════
  -- 12. Migration patch (for existing installs)
  -- ══════════════════════════════════════════════════════════════
  alter table goal_progress add column if not exists verification_status text check (verification_status in ('pending', 'verified', 'failed', 'challenged'));
  alter table goal_progress add column if not exists verification_reason text;
  alter table goal_progress add column if not exists verified_at timestamptz;
  alter table goal_progress add column if not exists verified_by text;
  alter table goal_progress add column if not exists audit_required boolean default false;
  alter table goal_progress add column if not exists challenge_window_ends_at timestamptz;

  alter table goals add column if not exists completed_at timestamptz;

  alter table missed_days add column if not exists required_votes int default 2;
  alter table missed_days add column if not exists partner_count_snapshot int default 0;

  create table if not exists missed_goal_deadlines (
    id uuid default gen_random_uuid() primary key,
    user_id uuid references auth.users(id) on delete cascade not null,
    goal_id uuid references goals(id) on delete cascade not null,
    deadline date not null,
    excuse text not null,
    requested_deadline date,
    extension_applied boolean default false,
    was_avoidable boolean,
    excuse_id text,
    required_votes int default 2,
    partner_count_snapshot int default 0,
    email_sent boolean default false,
    verdict text check (verdict in ('accepted', 'rejected')),
    vote_accepts int default 0,
    vote_rejects int default 0,
    vote_total int default 0,
    shame_email_sent boolean default false,
    punishment_acknowledged boolean default false,
    created_at timestamptz default now(),
    unique(user_id, goal_id, deadline)
  );
  alter table missed_goal_deadlines add column if not exists requested_deadline date;
  alter table missed_goal_deadlines add column if not exists extension_applied boolean default false;
  alter table missed_goal_deadlines add column if not exists required_votes int default 2;
  alter table missed_goal_deadlines add column if not exists partner_count_snapshot int default 0;

  alter table excuse_votes add column if not exists owner_user_id uuid references auth.users(id) on delete cascade;
  alter table excuse_votes add column if not exists source_type text check (source_type in ('missed_day', 'deadline'));
  alter table excuse_votes add column if not exists source_id uuid;

  create table if not exists excuse_vote_invites (
    id uuid default gen_random_uuid() primary key,
    user_id uuid references auth.users(id) on delete cascade not null,
    source_type text not null check (source_type in ('missed_day', 'deadline')),
    source_id uuid not null,
    excuse_id text not null,
    voter_email text not null,
    missed_date text not null,
    excuse_text text,
    token_hash text not null unique,
    expires_at timestamptz not null,
    used_at timestamptz,
    created_at timestamptz default now(),
    unique (excuse_id, voter_email)
  );

  -- Recreate hardened policies and triggers/functions idempotently
  alter table missed_days enable row level security;
  drop policy if exists "Users manage own missed_days" on missed_days;
  drop policy if exists "Users read own missed_days" on missed_days;
  create policy "Users read own missed_days" on missed_days for select using (auth.uid() = user_id);
  drop policy if exists "Users insert own missed_days" on missed_days;
  create policy "Users insert own missed_days" on missed_days for insert with check (auth.uid() = user_id);
  drop policy if exists "Users update own missed_days" on missed_days;
  create policy "Users update own missed_days" on missed_days for update using (auth.uid() = user_id) with check (auth.uid() = user_id);

  alter table missed_goal_deadlines enable row level security;
  drop policy if exists "Users manage own missed_goal_deadlines" on missed_goal_deadlines;
  drop policy if exists "Users read own missed_goal_deadlines" on missed_goal_deadlines;
  create policy "Users read own missed_goal_deadlines" on missed_goal_deadlines for select using (auth.uid() = user_id);
  drop policy if exists "Users insert own missed_goal_deadlines" on missed_goal_deadlines;
  create policy "Users insert own missed_goal_deadlines" on missed_goal_deadlines for insert with check (auth.uid() = user_id);
  drop policy if exists "Users update own missed_goal_deadlines" on missed_goal_deadlines;
  create policy "Users update own missed_goal_deadlines" on missed_goal_deadlines for update using (auth.uid() = user_id) with check (auth.uid() = user_id);

  alter table excuse_votes enable row level security;
  drop policy if exists "Owners read own excuse_votes" on excuse_votes;
  create policy "Owners read own excuse_votes" on excuse_votes for select using (auth.uid() = owner_user_id);
  drop policy if exists "Allow anonymous inserts" on excuse_votes;
  drop policy if exists "Allow anonymous reads" on excuse_votes;

  alter table excuse_vote_invites enable row level security;
  drop policy if exists "Users read own vote invites" on excuse_vote_invites;
  create policy "Users read own vote invites" on excuse_vote_invites for select using (auth.uid() = user_id);

  -- Recreate guard/date/partner triggers and RPC functions
  create or replace function enforce_checkin_date_window()
  returns trigger
  language plpgsql
  as $$
  declare
    server_date date := timezone('utc', now())::date;
  begin
    if tg_op = 'INSERT' then
      if new.date < server_date - 1 or new.date > server_date then
        raise exception 'Check-in date must be today or yesterday (UTC)';
      end if;
    elsif tg_op = 'UPDATE' then
      if new.date <> old.date then
        raise exception 'Check-in date is immutable';
      end if;
      if old.date <> server_date and old.date <> server_date - 1 then
        raise exception 'Only recent check-ins can be edited';
      end if;
    end if;
    return new;
  end;
  $$;
  drop trigger if exists trg_enforce_checkin_date_window on checkins;
  create trigger trg_enforce_checkin_date_window before insert or update on checkins for each row execute function enforce_checkin_date_window();

  create or replace function enforce_partner_floor()
  returns trigger
  language plpgsql
  as $$
  declare
    current_count int;
  begin
    if current_user <> 'postgres' then
      select count(*) into current_count from accountability_partners where user_id = old.user_id;
      if current_count <= 3 then
        raise exception 'At least 3 accountability partners are required';
      end if;
    end if;
    return old;
  end;
  $$;
  drop trigger if exists trg_enforce_partner_floor on accountability_partners;
  create trigger trg_enforce_partner_floor before delete on accountability_partners for each row execute function enforce_partner_floor();

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
         or new.created_at is distinct from old.created_at then
        raise exception 'Direct outcome edits are blocked';
      end if;
    end if;
    return new;
  end;
  $$;
  drop trigger if exists trg_guard_missed_days_update on missed_days;
  create trigger trg_guard_missed_days_update before update on missed_days for each row execute function guard_missed_days_update();

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
         or new.created_at is distinct from old.created_at then
        raise exception 'Direct outcome edits are blocked';
      end if;
    end if;
    return new;
  end;
  $$;
  drop trigger if exists trg_guard_missed_goal_deadlines_update on missed_goal_deadlines;
  create trigger trg_guard_missed_goal_deadlines_update before update on missed_goal_deadlines for each row execute function guard_missed_goal_deadlines_update();

  -- Recreate vote RPC functions
  -- (same definitions as section 9)
  -- If you already ran section 9 in this same script, these CREATE OR REPLACE
  -- statements are safe and keep the latest hardened logic.
*/
