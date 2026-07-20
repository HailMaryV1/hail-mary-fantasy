-- Mary Performance Lab, Part 1 - the prediction archive.
--
-- Every recommendation Ask Mary produces becomes an immutable row here -
-- no update/delete policy, matching the spec's "never overwrite historical
-- predictions." Owner-scoped like squads/watchlist_entries (this is a
-- specific user's specific squad's recommendation, not shared platform
-- data like activity_log), written by Ask Mary's own server-rendered page
-- via a server action using the authenticated user's client - not the
-- pipeline's service-role connection.
--
-- One row per individual recommendation (one transfer move, or one
-- captaincy pick), not one row per page load - `kind` distinguishes the
-- two shapes sharing this table rather than needing two tables, since
-- most columns (squad/context/algorithm snapshot) are identical either
-- way. `recommendation_type` carries Ask Mary's own category label
-- ("best_immediate_move", "best_captain", "hold", etc.) as free text
-- (same "check constraint over enum type" house style as
-- watchlist_entries.watch_reasons) so new categories don't need a migration.
--
-- Deliberately NOT capturing: expected starting XI/bench (Ask Mary
-- doesn't compute one yet), ownership (unavailable from FanTeam's feed,
-- confirmed repeatedly this session), goal/assist/clean-sheet
-- probability per player (exists inside projections.inputs, not
-- currently surfaced on an AskMaryRecommendation - linking
-- algorithm_version_id + game_player_id lets this be joined back later
-- without duplicating it here). Don't invent columns for data the app
-- doesn't actually have.

create table predictions (
  id bigint generated always as identity primary key,
  user_id uuid not null references auth.users(id) on delete cascade,
  squad_id bigint not null references squads(id) on delete cascade,
  game_id bigint not null references fantasy_games(id) on delete cascade,
  gameweek integer,
  season text not null,
  algorithm_version_id bigint references algorithm_versions(id),
  recommendation_weights jsonb not null default '{}',
  planning_horizon integer not null,
  strategy text not null,
  transfer_limit integer,

  kind text not null check (kind in ('transfer', 'captain', 'hold')),
  recommendation_type text not null,
  rank integer,

  budget_remaining_before numeric(6, 2),
  free_transfers_before integer,

  out_game_player_id bigint references game_players(id),
  in_game_player_id bigint references game_players(id),
  out_price numeric(5, 2),
  in_price numeric(5, 2),
  transfer_cost numeric(5, 2),

  captain_game_player_id bigint references game_players(id),
  vice_captain_game_player_id bigint references game_players(id),

  expected_points_before numeric(6, 2),
  expected_points_after numeric(6, 2),
  expected_gain numeric(6, 2),
  hail_mary_score_diff numeric(6, 2),
  fixture_swing_diff numeric(6, 3),
  mary_move_score numeric(5, 1),
  confidence numeric(5, 1),
  risk text,
  reasons jsonb not null default '[]',
  warnings jsonb not null default '[]',

  created_at timestamptz not null default now()
);

create index on predictions (user_id, squad_id, gameweek);
create index on predictions (algorithm_version_id);
create index on predictions (out_game_player_id);
create index on predictions (in_game_player_id);

alter table predictions enable row level security;
create policy "own predictions select" on predictions for select using (auth.uid() = user_id);
create policy "own predictions insert" on predictions for insert with check (auth.uid() = user_id);
-- No update/delete policy anywhere, including for the owner - immutable
-- by design (Part 1: "Every prediction should be reproducible... never
-- overwrite historical recommendations").
