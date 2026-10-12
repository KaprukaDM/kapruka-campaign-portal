-- Adds the remaining portal homepage cards to the grantable tools list, run
-- once in Supabase → SQL Editor. Idempotent.
--
-- Originally only 6 cards were gated (ads, daraz, avurudhu, seo, pcagent,
-- revenue — see sql/users_and_tool_access.sql). Every card on the homepage
-- is now treated as a grantable tool: nothing is visible to a plain `user`
-- role until explicitly granted in User Management (admin/superadmin still
-- see everything, same bypass as before).

insert into tools (key, label) values
  ('campaign-booking', 'Book Campaign Slot'),
  ('content-calendar',  'Content Calendar'),
  ('hot-products',      'Hot Products'),
  ('new-products',      'Newly Added Products'),
  ('price-checker',     'Price Checker'),
  ('intl-gifting',      'International Gifting Price Checker'),
  ('business-scout',    'Business Scout'),
  ('page-hygiene',      'Page Hygiene Dashboard'),
  ('oos-dashboard',     'Out of Stock Dashboard'),
  ('homepage-slots',    'Homepage Slot Manager')
on conflict (key) do nothing;
