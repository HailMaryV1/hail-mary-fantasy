-- Web Push subscriptions for live golf score notifications. One row per
-- browser/device a user has enabled notifications on (not per-squad - a
-- golfer usually appears across several of a user's saved team variants
-- for the same tournament, and a real score change should fire ONE
-- notification, not one per team that happens to hold that golfer).
--
-- endpoint is the browser-issued PushSubscription URL - globally unique
-- per browser+origin registration, so it's the natural conflict key for
-- "already subscribed on this device" upserts.
--
-- Written to directly by scripts/poll_golf_live_scores.py over the same
-- DATABASE_URL connection every other Python script in this pipeline
-- uses (bypasses RLS by design, same trust level as the rest of the
-- pipeline) - the RLS policies below only govern the app's own
-- "use server" actions (frontend/src/app/push/actions.ts).
create table push_subscriptions (
  id bigint generated always as identity primary key,
  user_id uuid not null references auth.users(id) on delete cascade,
  endpoint text not null unique,
  p256dh text not null,
  auth text not null,
  created_at timestamptz not null default now(),
  is_active boolean not null default true
);

create index on push_subscriptions (user_id);
create index on push_subscriptions (is_active);

alter table push_subscriptions enable row level security;

create policy "own push subscriptions select" on push_subscriptions for select using (auth.uid() = user_id);
create policy "own push subscriptions insert" on push_subscriptions for insert with check (auth.uid() = user_id);
create policy "own push subscriptions update" on push_subscriptions for update using (auth.uid() = user_id);
create policy "own push subscriptions delete" on push_subscriptions for delete using (auth.uid() = user_id);
