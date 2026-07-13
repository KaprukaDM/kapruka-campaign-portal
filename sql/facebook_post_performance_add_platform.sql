-- Adds Instagram alongside Facebook in the existing organic performance
-- table so both platforms show together in one combined feed. Run once in
-- Supabase → SQL Editor, after facebook_post_performance.sql. Idempotent.

alter table facebook_post_performance
  add column if not exists platform text not null default 'facebook';

-- Replace the old (page_id, post_id) uniqueness with (platform, page_id,
-- post_id) — a Facebook post ID and an Instagram media ID could theoretically
-- collide, and page_id now also holds the Instagram Business Account ID for
-- instagram rows.
alter table facebook_post_performance
  drop constraint if exists facebook_post_performance_page_id_post_id_key;

alter table facebook_post_performance
  drop constraint if exists facebook_post_performance_platform_page_post_key;

alter table facebook_post_performance
  add constraint facebook_post_performance_platform_page_post_key
  unique (platform, page_id, post_id);

create index if not exists idx_fb_post_performance_platform
  on facebook_post_performance (platform);
