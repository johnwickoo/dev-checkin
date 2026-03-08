-- Punishment tasks: assigned when an excuse is rejected
-- Picks from custom suggestions or falls back to hardcoded options

create table if not exists punishment_tasks (
  id uuid default gen_random_uuid() primary key,
  user_id uuid references auth.users(id) on delete cascade not null,
  source_type text not null check (source_type in ('missed_day', 'deadline')),
  source_id uuid not null,
  description text not null,
  due_date date not null,
  completed boolean default false,
  completed_at timestamptz,
  proof_url text,
  created_at timestamptz default now(),
  unique(source_type, source_id)
);

alter table punishment_tasks enable row level security;

drop policy if exists "Users manage own punishment tasks" on punishment_tasks;
create policy "Users manage own punishment tasks"
  on punishment_tasks for all using (auth.uid() = user_id)
  with check (auth.uid() = user_id);

-- Pick a punishment: random custom suggestion, or fall back to the voted hardcoded option
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
  v_fallback_labels jsonb := '{
    "deep_work_2h": "Do a focused 2-hour deep work block and share proof",
    "no_social_24h": "No social media for 24 hours",
    "donate_20": "Donate $20 and share receipt"
  }'::jsonb;
begin
  -- Try to pick a random custom suggestion
  select suggestion into v_custom
  from punishment_suggestions
  where user_id = p_user_id
  order by random()
  limit 1;

  if v_custom is not null then
    return v_custom;
  end if;

  -- Fall back to hardcoded option
  return coalesce(
    v_fallback_labels ->> coalesce(p_fallback_choice, 'deep_work_2h'),
    v_fallback_labels ->> 'deep_work_2h'
  );
end;
$$;

-- Auto-create punishment task when verdict resolves to rejected
create or replace function create_punishment_task_on_reject()
returns trigger
language plpgsql
security definer
as $$
declare
  v_description text;
  v_due date;
begin
  -- Only fire when verdict changes to 'rejected'
  if new.verdict is distinct from 'rejected' then
    return new;
  end if;
  if old.verdict is not distinct from 'rejected' then
    return new;
  end if;

  v_description := pick_punishment_description(new.user_id, new.selected_punishment);
  v_due := current_date;

  -- Insert punishment task (ignore if already exists)
  insert into punishment_tasks (user_id, source_type, source_id, description, due_date)
  values (
    new.user_id,
    case when tg_table_name = 'missed_days' then 'missed_day' else 'deadline' end,
    new.id,
    v_description,
    v_due
  )
  on conflict (source_type, source_id) do nothing;

  return new;
end;
$$;

-- Attach triggers to both tables
drop trigger if exists trg_punishment_task_missed_days on missed_days;
create trigger trg_punishment_task_missed_days
  after update of verdict on missed_days
  for each row
  execute function create_punishment_task_on_reject();

drop trigger if exists trg_punishment_task_deadlines on missed_goal_deadlines;
create trigger trg_punishment_task_deadlines
  after update of verdict on missed_goal_deadlines
  for each row
  execute function create_punishment_task_on_reject();
