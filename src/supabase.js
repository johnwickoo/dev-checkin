import { createClient } from '@supabase/supabase-js'

// ── Supabase config ─────────────────────────────────────────
const SUPABASE_URL      = import.meta.env.VITE_SUPABASE_URL
const SUPABASE_ANON_KEY = import.meta.env.VITE_SUPABASE_ANON_KEY

export const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY)

/*
  Create this table in your Supabase SQL editor:

  create table excuse_votes (
    id uuid default gen_random_uuid() primary key,
    excuse_id text not null,
    missed_date text not null,
    voter_email text not null,
    vote text not null check (vote in ('accept', 'reject')),
    excuse_text text,
    created_at timestamptz default now(),
    unique (excuse_id, voter_email)
  );

  -- Enable RLS
  alter table excuse_votes enable row level security;

  -- Allow anonymous inserts (for voting from email links)
  create policy "Allow anonymous inserts"
    on excuse_votes for insert
    with check (true);

  -- Allow anonymous reads (to check if already voted)
  create policy "Allow anonymous reads"
    on excuse_votes for select
    using (true);
*/
