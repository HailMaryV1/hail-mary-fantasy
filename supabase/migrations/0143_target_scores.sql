-- Target Score: a new, separate layer above the single-gameweek Hail
-- Mary Rating (2026-08-23 user request - "I want to be able to select
-- what im looking for from the top... best for next 2/3/5 gameweeks").
-- One row is written per (player, horizon, anchor gameweek) ONLY for
-- players who already pass compute_projections.py's is_rating_eligible
-- gate at that anchor gameweek (real bookmaker odds or real Recent
-- Form) - a good fixture run alone never earns a row here, preserving
-- the "no rubbish" rule the user has been explicit about all session.
--
-- Grain is deliberately NOT projections' own (game_player_id, gameweek)
-- grain - a horizon score spans MULTIPLE gameweeks (start_gameweek
-- through start_gameweek + horizon - 1), so it doesn't fit as a column
-- on a single-gameweek projections row without either duplicating the
-- same value across every row in the window or picking one arbitrary
-- anchor. A dedicated table with its own (player, horizon, anchor) key
-- is the honest grain.
--
-- The 4 sub-ratings (form/fixture_difficulty/fixture_quantity/
-- live_odds) stay individually nullable even on an eligible row - e.g.
-- a GK's Form is thin (Recent Form has never modeled clean sheets), an
-- EFL Fantasy player's Fixture Difficulty may have zero market coverage
-- 3-5 gameweeks out (EFL's fallback strength model is Premier-League-
-- only today) - never fabricate a number to fill a gap, same
-- convention hail_mary_rating itself already follows.
create table target_scores (
    id bigint generated always as identity primary key,
    game_player_id bigint not null references game_players(id) on delete cascade,
    horizon smallint not null check (horizon in (1, 2, 3, 5)),
    start_gameweek int not null,
    end_gameweek int not null,
    -- Continuous weighted composite (not re-bucketed through a second
    -- percentile pass) - kept sortable and hand-checkable directly
    -- against the raw sub-scores stored in `inputs`.
    target_score numeric(4, 2) not null,
    form_rating smallint check (form_rating is null or form_rating between 1 and 10),
    fixture_difficulty_rating smallint check (fixture_difficulty_rating is null or fixture_difficulty_rating between 1 and 10),
    fixture_quantity_rating smallint check (fixture_quantity_rating is null or fixture_quantity_rating between 1 and 10),
    live_odds_rating smallint check (live_odds_rating is null or live_odds_rating between 1 and 10),
    -- Raw pre-bucketing figures + per-fixture breakdown for the window
    -- (opponent name/kickoff/difficulty per fixture) - the same "never
    -- just the number" convention projections.inputs already follows,
    -- and what the downloadable card's window-fixtures panel reads from
    -- directly rather than re-querying.
    inputs jsonb not null default '{}',
    created_at timestamptz not null default now(),
    unique (game_player_id, horizon, start_gameweek)
);

create index target_scores_horizon_start_gw_idx on target_scores (horizon, start_gameweek);
create index target_scores_game_player_id_idx on target_scores (game_player_id);

alter table target_scores enable row level security;
create policy "public read" on target_scores for select using (true);
