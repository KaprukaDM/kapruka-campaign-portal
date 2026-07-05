-- Ad Requests — fixed monthly ad-creative request quota (Persona/Occasion/etc.),
-- synced into the shared studio_calendar production pipeline.
-- Run once in Supabase → SQL Editor.

create table if not exists ad_requests (
  id             bigint generated always as identity primary key,
  created_at     timestamptz not null default now(),
  updated_at     timestamptz,
  month_year     text not null,          -- 'YYYY-MM' the request is for
  category_group text not null,          -- e.g. 'Persona Based', 'Occasion Based'
  category       text not null,          -- e.g. 'Girlfriend to Boyfriend'
  angle          text,                   -- creative angle / hook
  message        text,                   -- ad copy / caption
  reference_link text,
  submitted_by   text,
  status         text not null default 'Received',
  go_live_date   date                    -- optional: specific day within month_year to post
);

-- Fresh installs already have the column; this only matters for re-runs
-- against a table created before go_live_date existed.
alter table ad_requests add column if not exists go_live_date date;

create index if not exists idx_ad_requests_month on ad_requests (month_year, category);

-- Matches the rest of this project's tables — anon key drives everything directly.
alter table ad_requests disable row level security;
