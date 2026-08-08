-- Backend piece of the "Mary's console panel" feature (2026-08-08 user
-- request): per-game, per-market real-vs-fallback counts so the
-- frontend can show a green/red light for "are we actually getting
-- live bookmaker odds for this, or running on our own approximation"
-- instead of that being invisible. Raw counts only, deliberately - no
-- colour/label classification here, that's a presentation decision
-- left to the frontend (same separation already used elsewhere, e.g.
-- team_fixture_difficulty.source vs frontend/src/lib/playerStatus.ts's
-- tone mapping).
--
-- Scoped to a bounded near-term horizon (default 21 days), not all
-- future fixtures ever - matches what a user actually cares about
-- right now ("is Mary working with real data for what's coming up"),
-- not a number diluted by fixtures months away nobody's odds have
-- posted for yet.
--
-- Four markets, matching exactly what compute_projections.py's
-- Bookmaker Intelligence / fixture-difficulty pipeline actually reads:
--   match_odds        - team_fixture_difficulty.source = 'real_odds'
--                        (real win/draw/away market) vs the team-
--                        strength model fallback (labelled 'fdr' by
--                        migration 0103's view regardless of game -
--                        genuinely EFL's own FDR feed for eflfantasy,
--                        our own strength model for every other game).
--   clean_sheet        - a real fixture_clean_sheet_probabilities row
--                        vs the win/draw-derived approximation.
--   goal_probability   - bookmaker_player_features.is_estimated = false
--                        (a real "Anytime Goalscorer" market row) vs
--                        estimated-from-baseline or no row at all -
--                        checked against every active non-CLUB player
--                        in this game's pool, not just rows that
--                        happen to exist, so "no row" correctly counts
--                        as NOT real rather than being invisible.
--   assist_probability - same shape, assist_is_estimated.
create or replace function game_market_status(p_game_slug text, p_horizon_days int default 21)
returns table (market text, real_count bigint, total_count bigint)
language sql
stable
as $$
  with target_game as (
    select id from fantasy_games where slug = p_game_slug
  ),
  window_fixtures as (
    select tfd.fixture_id, tfd.team_id, tfd.source
    from team_fixture_difficulty tfd
    where tfd.game_id = (select id from target_game)
      and tfd.kickoff_at >= now()
      and tfd.kickoff_at < now() + (p_horizon_days || ' days')::interval
  ),
  match_odds as (
    select 'match_odds'::text as market,
           count(*) filter (where source = 'real_odds') as real_count,
           count(*) as total_count
    from window_fixtures
  ),
  clean_sheet as (
    select 'clean_sheet'::text as market,
           count(*) filter (where fcsp.clean_sheet_prob is not null) as real_count,
           count(*) as total_count
    from window_fixtures wf
    left join fixture_clean_sheet_probabilities fcsp
      on fcsp.fixture_id = wf.fixture_id and fcsp.team_id = wf.team_id
  ),
  player_fixture_pairs as (
    select p.id as player_id, wf.fixture_id
    from window_fixtures wf
    join players p on p.team_id = wf.team_id
    join game_players gp on gp.player_id = p.id and gp.game_id = (select id from target_game)
    where gp.is_active and gp.position_code != 'CLUB'
  ),
  goal_probability as (
    select 'goal_probability'::text as market,
           count(*) filter (where bpf.is_estimated = false) as real_count,
           count(*) as total_count
    from player_fixture_pairs pfp
    left join bookmaker_player_features bpf
      on bpf.player_id = pfp.player_id and bpf.fixture_id = pfp.fixture_id
  ),
  assist_probability as (
    select 'assist_probability'::text as market,
           count(*) filter (where bpf.assist_is_estimated = false) as real_count,
           count(*) as total_count
    from player_fixture_pairs pfp
    left join bookmaker_player_features bpf
      on bpf.player_id = pfp.player_id and bpf.fixture_id = pfp.fixture_id
  )
  select * from match_odds
  union all select * from clean_sheet
  union all select * from goal_probability
  union all select * from assist_probability;
$$;
