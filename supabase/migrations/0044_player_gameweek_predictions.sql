-- Hail Mary Form System, Part 1 - the frozen prediction archive.
--
-- Distinct from `projections` (mutable - recomputed by every
-- compute_projections.py run right up to kickoff, and currently even
-- after it, since nothing stops that) and from `predictions` (Ask Mary's
-- own transfer/captain recommendation log, migration 0033 - a different
-- grain entirely: one row per recommended MOVE a user saw, not one row
-- per player per gameweek). This table is a per-player-per-gameweek
-- SNAPSHOT of what projections.hail_mary_score said right before the
-- deadline, permanently preserved even as projections keeps getting
-- overwritten afterwards - the only way to later ask "was Mary's
-- original pre-deadline call right" instead of comparing against
-- whatever projections happens to say today. Migration 0033's own
-- docstring already anticipated this exact gap: "this data exists inside
-- projections.inputs... can be joined back later without duplicating it
-- here."
--
-- Freeze mechanism: `locked_at` is null until this gameweek's deadline
-- (earliest kickoff_at among its fixtures - same definition
-- frontend/src/lib/gameweek.ts's getSeasonTiming already uses) has
-- passed. scripts/capture_gameweek_predictions.py's UPSERT for every
-- expected_* column includes `where player_gameweek_predictions.locked_at
-- is null` on its ON CONFLICT DO UPDATE clause - a locked row's write
-- silently no-ops, an unlocked row keeps refreshing on every pipeline run
-- right up to the deadline (predicted_at tracks the most recent pre-lock
-- refresh), and the same statement sets locked_at = now() the first run
-- after the deadline passes. Re-running the capture script is always safe.
--
-- unique(game_player_id, gameweek), deliberately NOT including
-- algorithm_version_id - only one canonical frozen prediction per player
-- per gameweek, whichever model version happened to produce it;
-- algorithm_version_id/model_version_label are descriptive columns, not
-- part of the key (mirrors player_gameweek_results' own key exactly,
-- migration 0034).
--
-- Actual-side columns (actual_minutes, actual_points, points_difference,
-- minutes_adjusted_difference, ...) are attached later by a separate
-- script (scripts/attach_gameweek_results.py) once player_gameweek_results
-- has data for that gameweek, and are deliberately NOT covered by the
-- locked_at guard - they can be corrected by a later, more-settled
-- capture, same philosophy player_gameweek_results itself already uses.
--
-- actual_goals/actual_assists/actual_clean_sheets/actual_yellow_cards/
-- actual_red_cards are built now but genuinely unpopulated: confirmed
-- live this session that FanTeam's scraped feed only ever carries an
-- aggregate points number + minutes (no goal/assist/clean-sheet/card
-- breakdown anywhere in the raw JSON), the Odds API integration in this
-- codebase is pre-match odds not results, and game_player_stats has zero
-- real per-gameweek rows (only last season's historical-CSV totals, all
-- at gameweek=0). These columns exist so a real stats feed (Opta,
-- Understat, a different endpoint...) can populate them later without
-- another migration - don't backfill them with anything until one exists.
--
-- expected_floor/expected_ceiling are a v1 heuristic (see
-- scripts/capture_gameweek_predictions.py's compute_floor/compute_ceiling)
-- with no historical prediction-error data to calibrate against yet -
-- recalibrate once real variance accumulates, which is the whole point of
-- this table existing.
--
-- Same public-read/service-role-write pattern as player_gameweek_results/
-- predictions - only the pipeline's service-role DATABASE_URL connection
-- writes here. RLS can't express "these specific columns are immutable
-- after a point in time" on its own - that's the locked_at guard in the
-- application-layer UPSERT, not a DB policy.

create table player_gameweek_predictions (
  id bigint generated always as identity primary key,
  game_id bigint not null references fantasy_games(id) on delete cascade,
  game_player_id bigint not null references game_players(id) on delete cascade,
  gameweek integer not null,

  -- Expected side - frozen once locked_at is set, see docstring above.
  algorithm_version_id bigint references algorithm_versions(id),
  model_version_label text,              -- denormalized algorithm_versions.version_label, cheap reads without a join
  expected_points numeric(6, 2),         -- = projections.hail_mary_score at freeze time
  expected_points_per_90 numeric(6, 2),  -- = inputs.points_per_90 at freeze time; needed for minutes_adjusted_difference later
  expected_floor numeric(6, 2),
  expected_ceiling numeric(6, 2),
  predicted_minutes numeric(5, 1),
  appearance_probability numeric(5, 4),
  start_probability numeric(5, 4),       -- proxy: minutes_60_plus.projected - see capture script docstring for why
  goal_probability numeric(6, 4),
  assist_probability numeric(6, 4),
  clean_sheet_probability numeric(5, 4), -- really clean_sheet_60min - see capture script docstring
  confidence numeric(5, 1),
  predicted_at timestamptz,              -- when this row was last (re)captured pre-lock
  locked_at timestamptz,                 -- null until this gameweek's deadline has passed - see docstring above

  -- Actual side - attached later by scripts/attach_gameweek_results.py,
  -- nullable, never covered by the locked_at guard. Only actual_minutes/
  -- actual_points are populatable today - see docstring above.
  actual_minutes integer,
  actual_points numeric(6, 2),
  actual_goals integer,
  actual_assists integer,
  actual_clean_sheets integer,
  actual_yellow_cards integer,
  actual_red_cards integer,
  points_difference numeric(6, 2),           -- actual_points - expected_points
  minutes_adjusted_difference numeric(6, 2), -- actual_points - (expected_points_per_90 * actual_minutes / 90) - isolates minutes-model error from genuine performance difference, see attach_gameweek_results.py's docstring
  actuals_captured_at timestamptz,

  unique (game_player_id, gameweek)
);

create index on player_gameweek_predictions (game_id, gameweek);
create index on player_gameweek_predictions (game_player_id);

alter table player_gameweek_predictions enable row level security;
create policy "public read" on player_gameweek_predictions for select using (true);
-- No insert/update/delete policy for anon/authenticated - only the
-- pipeline's service-role connection writes.
