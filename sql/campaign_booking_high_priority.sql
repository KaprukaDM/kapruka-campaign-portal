-- Campaign booking slots → always HIGH priority on the studio calendar.
-- Run once in Supabase → SQL Editor. Idempotent (safe to re-run).
--
-- Background
-- ----------
-- Campaign bookings (campaign-booking.html → request_log) are mirrored onto
-- studio_calendar with source_type = 'campaign_booking'. They are committed
-- promotions with a fixed go-live date, so they are always high priority.
--
-- The app now writes priority = 'High' for these rows on every path
-- (upsertStudioCalendarEntry() forces it in js/supabase-api.js), and the
-- admin studio calendar renders them as High regardless of the stored value.
-- This script fixes the stored value for rows created before that change.
--
-- The portal also runs the same backfill from the client on studio calendar
-- load (backfillCampaignBookingPriority()); this file is the direct SQL
-- equivalent for anyone who prefers to do it in one shot on the DB.
--
-- NOTE on the "Promotion Time Sensitive" label: studio_calendar has no
-- labels/tags column, and this label is derived from source_type in
-- getStudioSlotLabels() rather than stored — so there is nothing to migrate
-- for it, and every existing campaign booking row picks it up automatically.

-- 1. Backfill existing campaign booking slots.
update studio_calendar
   set priority = 'High'
 where source_type = 'campaign_booking'
   and (priority is distinct from 'High');

-- 2. Keep it true for anything written outside the portal (e.g. manual inserts
--    or a future service that writes straight to the table).
create or replace function studio_calendar_force_campaign_priority()
returns trigger
language plpgsql
as $$
begin
  if new.source_type = 'campaign_booking' then
    new.priority := 'High';
  end if;
  return new;
end;
$$;

drop trigger if exists trg_studio_calendar_campaign_priority on studio_calendar;
create trigger trg_studio_calendar_campaign_priority
  before insert or update on studio_calendar
  for each row execute function studio_calendar_force_campaign_priority();

-- Verify:
--   select priority, count(*) from studio_calendar
--    where source_type = 'campaign_booking' group by priority;
--   -- expected: a single row, priority = 'High'
