-- Align backend check-in validation with current UI:
-- "What I Built" is optional.

create or replace function enforce_checkin_quality()
returns trigger
language plpgsql
as $$
declare
  has_active_goals boolean;
begin
  select exists (
    select 1
    from goals
    where goals.user_id = new.user_id
      and goals.active = true
  ) into has_active_goals;

  if has_active_goals then
    if coalesce(length(trim(new.learned)), 0) < 50 then
      raise exception 'Check-in must include at least 50 characters in "learned".';
    end if;
    -- built is intentionally optional.
  end if;

  return new;
end;
$$;

drop trigger if exists trg_enforce_checkin_quality on checkins;
create trigger trg_enforce_checkin_quality
  before insert or update on checkins
  for each row execute function enforce_checkin_quality();
