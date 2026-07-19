-- Global activity feed: the automated twice-daily pipeline
-- (.github/workflows/refresh_data.yml -> scripts/refresh_all.py)
-- already detects most of this (new FanTeam players, Hail Mary Score
-- swings, real-world club transfers, fixture reschedules) - it was just
-- only ever printed as aggregate counts in a CI log nobody reads day to
-- day. This makes it a real, queryable feed instead.
--
-- Written to directly by the pipeline scripts at the exact points they
-- already compute this information (see scripts/activity_log.py) - not
-- a new orchestration step, refresh_all.py needs no changes since
-- logging happens inside the scripts it already calls.
--
-- Public-read, not auth.uid()-scoped - this is shared platform data
-- (new players, score changes, fixture reschedules), not personal to
-- any one user, same convention as game_squad_rules/game_competitions.
-- Only the pipeline's service-role DATABASE_URL connection ever writes
-- to it - no insert/update/delete policy needed for the anon key.

create table activity_log (
  id bigint generated always as identity primary key,
  event_type text not null,  -- 'player_added' | 'score_changed' | 'team_changed' | 'fixture_added' | 'fixture_rescheduled'
  game_id bigint references fantasy_games(id) on delete cascade,
  game_player_id bigint references game_players(id) on delete cascade,
  fixture_id bigint references fixtures(id) on delete cascade,
  summary text not null,
  details jsonb not null default '{}',
  created_at timestamptz not null default now()
);

create index on activity_log (created_at desc);
create index on activity_log (event_type);

alter table activity_log enable row level security;
create policy "public read" on activity_log for select using (true);
