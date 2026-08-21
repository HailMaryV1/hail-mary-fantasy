-- Generalizes get_efl_market_odds(int) into get_market_odds(text, int) -
-- 2026-08-21 user request to extend the "Market Odds" page (built for EFL
-- Fantasy) to Dream Team/FanTeam/Cloud FF's real Premier League odds.
--
-- The old function's only EFL-specific logic was a literal
-- `fg.slug = 'eflfantasy'` scoping which game's game_fixture_gameweeks
-- calendar to read - everything downstream (team_fixture_difficulty,
-- fixture_probabilities, fixture_clean_sheet_probabilities) was already
-- generic and already carries real Premier League rows for these 3 games
-- (confirmed live via the existing game_market_status(p_game_slug, ...)
-- RPC, migration 0107, which is the direct precedent for this same
-- p_game_slug parameter pattern). Dropped and recreated rather than kept
-- alongside a shim - there is exactly one caller in this codebase, and
-- it's being updated in the same change.
drop function if exists get_efl_market_odds(int);

create function get_market_odds(p_game_slug text, p_gameweek int)
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
  with scoped_fixtures as (
    select distinct f.id as fixture_id, f.competition, f.kickoff_at, f.home_team_id, f.away_team_id
    from game_fixture_gameweeks gfg
    join fixtures f on f.id = gfg.fixture_id
    join fantasy_games fg on fg.id = gfg.game_id
    where fg.slug = p_game_slug and gfg.gameweek = p_gameweek
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
    case when tfd.team_id = sf.home_team_id then sf.away_team_id else sf.home_team_id end as opponent_team_id,
    ot.name as opponent_name,
    tfd.team_id = sf.home_team_id as is_home,
    round(tfd.attack_score * 100, 1) as win_prob,
    round(
      case when tfd.team_id = sf.home_team_id then erp.home_win_prob else erp.away_win_prob end * 100, 1
    ) as win_prob_opening,
    round(tfd.clean_sheet_score * 100, 1) as clean_sheet_pct,
    round(
      coalesce(
        ecs.clean_sheet_prob,
        (case when tfd.team_id = sf.home_team_id then erp.home_win_prob else erp.away_win_prob end)
          + 0.5 * erp.draw_prob
      ) * 100, 1
    ) as clean_sheet_pct_opening,
    tfd.expected_goals
  from scoped_fixtures sf
  join team_fixture_difficulty tfd on tfd.fixture_id = sf.fixture_id
  join teams t on t.id = tfd.team_id
  join teams ot on ot.id = (case when tfd.team_id = sf.home_team_id then sf.away_team_id else sf.home_team_id end)
  left join earliest_real_prob erp on erp.fixture_id = sf.fixture_id
  left join earliest_clean_sheet ecs on ecs.fixture_id = sf.fixture_id and ecs.team_id = tfd.team_id
  order by sf.kickoff_at, sf.fixture_id, is_home desc;
$$;
