-- FanTeam Golf, Phase 4 - the frozen prediction archive. Same shape and
-- freeze mechanism as player_gameweek_predictions (migration 0044) for
-- football: a per-golfer-per-tournament SNAPSHOT of what
-- projections.hail_mary_score (and its floor/ceiling/probabilities, from
-- inputs jsonb) said right before this tournament's deadline, permanently
-- preserved even as projections keeps getting overwritten by later
-- compute_golf_projections.py runs against other tournaments.
--
-- Golf's deadline is golf_tournaments.registration_time (confirmed field
-- from the real API, not guessed) - the golf equivalent of a gameweek's
-- earliest kickoff_at. locked_at is null until that passes;
-- capture_golf_predictions.py's UPSERT for every expected_* column
-- includes `where locked_at is null` - a locked row's write silently
-- no-ops, an unlocked row keeps refreshing right up to the deadline, and
-- the same statement sets locked_at = now() the first run after the
-- deadline passes.
--
-- Actual-side columns are separate and not locked - attached by
-- attach_golf_tournament_results.py once FanTeam has posted a real
-- points value for that golfer in that tournament (read from
-- golf_tournament_entries.raw->>'points', not a separate results table -
-- unlike football, golf's own weekly re-import already refreshes that
-- jsonb blob with final scores once the tournament concludes, so no new
-- "results" table is needed, just a script that reads it).
--
-- unique(tournament_id, game_player_id), deliberately not including
-- algorithm_version_id - only one canonical frozen prediction per golfer
-- per tournament, whichever model version happened to produce it.

create table golf_tournament_predictions (
  id bigint generated always as identity primary key,
  tournament_id bigint not null references golf_tournaments(id) on delete cascade,
  game_player_id bigint not null references game_players(id) on delete cascade,

  -- Expected side - frozen once locked_at is set (see docstring above).
  algorithm_version_id bigint references algorithm_versions(id),
  model_version_label text,
  expected_points numeric(6, 2),
  expected_floor numeric(6, 2),
  expected_ceiling numeric(6, 2),
  value numeric(6, 3),                  -- expected_points / price at freeze time
  make_cut_probability numeric(5, 4),
  top_finish_probability numeric(5, 4),
  boom_probability numeric(5, 4),
  bust_probability numeric(5, 4),
  price numeric(6, 2),
  predicted_at timestamptz,
  locked_at timestamptz,

  -- Actual side - attached later, nullable, never covered by locked_at.
  actual_points numeric(6, 2),
  points_difference numeric(6, 2),      -- actual_points - expected_points
  actuals_captured_at timestamptz,

  unique (tournament_id, game_player_id)
);

create index on golf_tournament_predictions (tournament_id);
create index on golf_tournament_predictions (game_player_id);

alter table golf_tournament_predictions enable row level security;
create policy "public read" on golf_tournament_predictions for select using (true);
-- No write policy for anon/authenticated - service-role pipeline only.
