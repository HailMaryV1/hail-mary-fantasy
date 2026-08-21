-- 2026-08-21 user request: "at the bottom of the player pools on every game
-- i want it to have a time stamp on when the last update was on the player
-- projections. So i know im using fresh data not stale data."
--
-- projections.created_at is NOT a usable signal for this - it's set once at
-- first insert and upsert_projection's own "on conflict ... do update set"
-- clause never touches it (only hail_mary_score/inputs/period_start/
-- period_end are updated in place), so a player's row keeps its original
-- creation timestamp forever even as its score gets recomputed on every
-- scheduled run. algorithm_versions.created_at has the same problem from
-- the other direction - get_or_create_algorithm_version only mints a new
-- row when the WEIGHTS actually change (a real tuning change), not on every
-- routine recompute that reuses the same version. Neither reflects "when
-- did this game's projections last actually get touched."
--
-- updated_at is a genuine last-write timestamp: it's set on both the
-- initial insert (default now()) and explicitly bumped in both of
-- upsert_projection's "do update set" clauses (see compute_projections.py),
-- so max(updated_at) for a game is really "the last time compute_
-- projections.py successfully wrote a score for this game."
alter table projections add column updated_at timestamptz not null default now();

-- Backfill existing rows so freshness isn't reported as "never" for
-- already-computed data - created_at is the best available approximation
-- for rows that predate this column.
update projections set updated_at = created_at;

-- One row per game, cheap to query from the frontend (poolSearch.ts's own
-- search_game_player_pool RPC already does the identical projections ->
-- game_players -> fantasy_games join per-row inside its `scored` CTE - this
-- view does the same join once, aggregated).
create view game_projection_freshness as
select
  fg.id as game_id,
  fg.slug as game_slug,
  max(p.updated_at) as last_updated
from fantasy_games fg
join game_players gp on gp.game_id = fg.id
join projections p on p.game_player_id = gp.id
group by fg.id, fg.slug;
