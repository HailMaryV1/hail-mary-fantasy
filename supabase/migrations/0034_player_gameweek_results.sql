-- Mary Performance Lab, Part 2 - the missing "what actually happened"
-- data. fanteam_player_status.total_points/last_points cannot serve this
-- role: it's a pre-match snapshot for whichever gameweek is currently
-- EDITABLE (upcoming), upsert-overwritten every scrape, with no history
-- once a gameweek closes and the editable round advances (confirmed by
-- reading import_fanteam_live.py and migration 0029's own docstring).
--
-- This table is populated by a new scripts/capture_gameweek_actuals.py,
-- run after every import_fanteam_live.py in the pipeline: FanTeam's
-- `lastPoints`/`minutes` fields captured under gameweek N's editable-round
-- scrape are read as gameweek N-1's ACTUAL result (the most recently
-- completed gameweek relative to the one currently open for transfers) -
-- unique on (game_id, game_player_id, gameweek) so a later, more-settled
-- scrape (e.g. after a post-match points correction) can safely
-- overwrite an earlier one for the same gameweek.
--
-- UNCONFIRMED, same as the lineup/status raw-string mapping in
-- compute_projections.py: this table's exact semantics (does
-- "lastPoints" really mean "previous gameweek's points", or something
-- else) can't be verified until a real gameweek actually completes -
-- there is no season-started data yet. Capture it now so it's ready the
-- moment GW1 finishes, and sanity-check the first real values then.
--
-- Shared platform data (not personal), same public-read/service-role-write
-- pattern as activity_log/fanteam_player_status - only the pipeline's
-- service-role DATABASE_URL connection ever writes here.

create table player_gameweek_results (
  id bigint generated always as identity primary key,
  game_id bigint not null references fantasy_games(id) on delete cascade,
  game_player_id bigint not null references game_players(id) on delete cascade,
  gameweek integer not null,
  actual_points numeric(6, 2),
  actual_minutes integer,
  captured_at timestamptz not null default now(),
  unique (game_id, game_player_id, gameweek)
);

create index on player_gameweek_results (game_id, gameweek);

alter table player_gameweek_results enable row level security;
create policy "public read" on player_gameweek_results for select using (true);
