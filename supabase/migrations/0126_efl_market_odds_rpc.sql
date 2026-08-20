-- Real per-team market data for one EFL Fantasy gameweek's fixtures -
-- 2026-08-20 user request, EFL-only "Market Odds" page (Championship/
-- League One/League Two - explicitly not Premier League). One RPC call
-- server-side rather than several round-trips from the client, and lets
-- the "how far the price has moved since it opened" delta be computed
-- directly against the real append-only fixture_probabilities/fixture_
-- clean_sheet_probabilities history (earliest real_odds snapshot vs the
-- latest) instead of re-deriving it client-side.
--
-- Deliberately no delta for expected_goals - that figure is a derived
-- (Poisson-calibrated, see compute_expected_goals.py) estimate, not a
-- raw market snapshot, and doesn't have its own history table; showing
-- a fabricated delta for it would overstate precision this project
-- doesn't actually have yet.
create or replace function get_efl_market_odds(p_gameweek int)
returns table (
  fixture_id bigint,
  competition text,
  kickoff_at timestamptz,
  team_id bigint,
  team_name text,
  opponent_team_id bigint,
  opponent_name text,
  is_home boolean,
  win_prob numeric,
  win_prob_opening numeric,
  clean_sheet_pct numeric,
  clean_sheet_pct_opening numeric,
  expected_goals numeric
)
language sql stable
as $$
  with efl_fixtures as (
    select distinct f.id as fixture_id, f.competition, f.kickoff_at, f.home_team_id, f.away_team_id
    from game_fixture_gameweeks gfg
    join fixtures f on f.id = gfg.fixture_id
    join fantasy_games fg on fg.id = gfg.game_id
    where fg.slug = 'eflfantasy' and gfg.gameweek = p_gameweek
  ),
  earliest_real_prob as (
    select distinct on (fixture_id) fixture_id, home_win_prob, draw_prob, away_win_prob
    from fixture_probabilities
    order by fixture_id, computed_at asc
  ),
  earliest_clean_sheet as (
    select distinct on (fixture_id, team_id) fixture_id, team_id, clean_sheet_prob
    from fixture_clean_sheet_probabilities
    order by fixture_id, team_id, computed_at asc
  )
  select
    tfd.fixture_id, tfd.competition, tfd.kickoff_at, tfd.team_id, t.name as team_name,
    case when tfd.team_id = ef.home_team_id then ef.away_team_id else ef.home_team_id end as opponent_team_id,
    ot.name as opponent_name,
    tfd.team_id = ef.home_team_id as is_home,
    round(tfd.attack_score * 100, 1) as win_prob,
    round(
      case when tfd.team_id = ef.home_team_id then erp.home_win_prob else erp.away_win_prob end * 100, 1
    ) as win_prob_opening,
    round(tfd.clean_sheet_score * 100, 1) as clean_sheet_pct,
    round(
      coalesce(
        ecs.clean_sheet_prob,
        (case when tfd.team_id = ef.home_team_id then erp.home_win_prob else erp.away_win_prob end)
          + 0.5 * erp.draw_prob
      ) * 100, 1
    ) as clean_sheet_pct_opening,
    tfd.expected_goals
  from efl_fixtures ef
  join team_fixture_difficulty tfd on tfd.fixture_id = ef.fixture_id
  join teams t on t.id = tfd.team_id
  join teams ot on ot.id = (case when tfd.team_id = ef.home_team_id then ef.away_team_id else ef.home_team_id end)
  left join earliest_real_prob erp on erp.fixture_id = ef.fixture_id
  left join earliest_clean_sheet ecs on ecs.fixture_id = ef.fixture_id and ecs.team_id = tfd.team_id
  order by ef.kickoff_at, ef.fixture_id, is_home desc;
$$;
