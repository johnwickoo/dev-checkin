import { createClient } from '@supabase/supabase-js'

const SUPABASE_URL      = import.meta.env.VITE_SUPABASE_URL
const SUPABASE_ANON_KEY = import.meta.env.VITE_SUPABASE_ANON_KEY

export const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY)

/*
  Run this SQL in your Supabase SQL Editor to set up all tables:

  -- ══════════════════════════════════════════════════════════════
  -- 1. Goals
  -- ══════════════════════════════════════════════════════════════
  create table goals (
    id uuid default gen_random_uuid() primary key,
    user_id uuid references auth.users(id) on delete cascade not null,
    title text not null,
    deadline date,
    active boolean default true,
    created_at timestamptz default now()
  );

  alter table goals enable row level security;
  create policy "Users manage own goals"
    on goals for all using (auth.uid() = user_id)
    with check (auth.uid() = user_id);

  -- ══════════════════════════════════════════════════════════════
  -- 2. Check-ins
  -- ══════════════════════════════════════════════════════════════
  create table checkins (
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
  create policy "Users manage own checkins"
    on checkins for all using (auth.uid() = user_id)
    with check (auth.uid() = user_id);

  -- ══════════════════════════════════════════════════════════════
  -- 3. Goal progress (per check-in)
  -- ══════════════════════════════════════════════════════════════
  create table goal_progress (
    id uuid default gen_random_uuid() primary key,
    checkin_id uuid references checkins(id) on delete cascade not null,
    goal_id uuid references goals(id) on delete cascade not null,
    completed boolean default false,
    proof_url text,
    proof_image_path text,
    unique(checkin_id, goal_id)
  );

  alter table goal_progress enable row level security;
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
  create table missed_days (
    id uuid default gen_random_uuid() primary key,
    user_id uuid references auth.users(id) on delete cascade not null,
    date date not null,
    excuse text not null,
    was_avoidable boolean,
    excuse_id text,
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
  create policy "Users manage own missed_days"
    on missed_days for all using (auth.uid() = user_id)
    with check (auth.uid() = user_id);

  -- ══════════════════════════════════════════════════════════════
  -- 5. Accountability partners
  -- ══════════════════════════════════════════════════════════════
  create table accountability_partners (
    id uuid default gen_random_uuid() primary key,
    user_id uuid references auth.users(id) on delete cascade not null,
    email text not null,
    created_at timestamptz default now(),
    unique(user_id, email)
  );

  alter table accountability_partners enable row level security;
  create policy "Users manage own partners"
    on accountability_partners for all using (auth.uid() = user_id)
    with check (auth.uid() = user_id);

  -- ══════════════════════════════════════════════════════════════
  -- 6. Excuse votes (already exists — keep or recreate)
  -- ══════════════════════════════════════════════════════════════
  create table if not exists excuse_votes (
    id uuid default gen_random_uuid() primary key,
    excuse_id text not null,
    missed_date text not null,
    voter_email text not null,
    vote text not null check (vote in ('accept', 'reject')),
    excuse_text text,
    created_at timestamptz default now(),
    unique (excuse_id, voter_email)
  );

  alter table excuse_votes enable row level security;
  create policy "Allow anonymous inserts"
    on excuse_votes for insert with check (true);
  create policy "Allow anonymous reads"
    on excuse_votes for select using (true);

  -- ══════════════════════════════════════════════════════════════
  -- 7. Storage bucket for proof images
  -- ══════════════════════════════════════════════════════════════
  insert into storage.buckets (id, name, public) values ('proof-images', 'proof-images', true);

  create policy "Users upload own proof images"
    on storage.objects for insert
    with check (bucket_id = 'proof-images' and auth.role() = 'authenticated');

  create policy "Public read proof images"
    on storage.objects for select
    using (bucket_id = 'proof-images');

  create policy "Users delete own proof images"
    on storage.objects for delete
    using (bucket_id = 'proof-images' and auth.uid()::text = (storage.foldername(name))[1]);
*/
