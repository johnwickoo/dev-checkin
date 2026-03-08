-- Punishment suggestions table
-- Partners can suggest custom punishments for a user

create table if not exists punishment_suggestions (
  id uuid default gen_random_uuid() primary key,
  user_id uuid references auth.users(id) on delete cascade not null,
  suggested_by_email text not null,
  suggestion text not null check (char_length(suggestion) between 3 and 200),
  created_at timestamptz default now()
);

alter table punishment_suggestions enable row level security;

-- Owner can read their own suggestions
drop policy if exists "Users read own suggestions" on punishment_suggestions;
create policy "Users read own suggestions"
  on punishment_suggestions for select using (auth.uid() = user_id);

-- Anyone can insert (public page, no auth required)
drop policy if exists "Anyone can suggest" on punishment_suggestions;
create policy "Anyone can suggest"
  on punishment_suggestions for insert with check (true);

-- RPC to submit a suggestion (public, rate-limited by email per user per day)
create or replace function submit_punishment_suggestion(
  p_user_id uuid,
  p_email text,
  p_suggestion text
)
returns jsonb
language plpgsql
security definer
as $$
declare
  recent_count int;
begin
  -- Rate limit: max 5 suggestions per email per user per day
  select count(*) into recent_count
  from punishment_suggestions
  where user_id = p_user_id
    and suggested_by_email = lower(trim(p_email))
    and created_at > now() - interval '24 hours';

  if recent_count >= 5 then
    return jsonb_build_object('status', 'rate_limited');
  end if;

  insert into punishment_suggestions (user_id, suggested_by_email, suggestion)
  values (p_user_id, lower(trim(p_email)), trim(p_suggestion));

  return jsonb_build_object('status', 'submitted');
end;
$$;
