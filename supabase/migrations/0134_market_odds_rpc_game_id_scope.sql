-- Fixes a real duplicate-rows bug in get_market_odds, found live
-- 2026-08-21 right after widening it to Premier League games: team_
-- fixture_difficulty is a CROSS-GAME view - one row per (fixture, team)
-- PER GAME that has the fixture's competition registered in game_
-- competitions (see 0125_fixture_expected_goals.sql's view definition,
-- `join game_competitions gc on gc.competition = f.competition` - no
-- game_id scoping at all). For EFL Fantasy's own competitions
-- (efl_championship/league_one/league_two) this was invisible - EFL
-- Fantasy is the ONLY game with those registered, so the join always
-- produced exactly one row. soccer_epl is registered by THREE games
-- (dreamteam, fanteam, cloudff - see seed.sql / 0074_cloudff_game_
-- competitions.sql), so scoped_fixtures's join to team_fixture_
-- difficulty (by fixture_id alone) matched all three games' identical-
-- looking rows at once - every Premier League team/fixture appeared 3x
-- in the Market Odds page for any of these 3 games.
--
-- Fix: scoped_fixtures already resolves exactly one game_id (via
-- fg.slug = p_game_slug), so carry it through and use it to scope the
-- team_fixture_difficulty join to that one game's own rows - the same
-- data every one of them carries anyway (win/clean-sheet/expected-goals
-- are game-independent facts about the fixture), just picking one
-- instead of joining all matching copies.
create or replace function get_market_odds(p_game_slug text, p_gameweek int)
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
    select distinct f.id as fixture_id, f.competition, f.kickoff_at, f.home_team_id, f.away_team_id, fg.id as game_id
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
  join team_fixture_difficulty tfd on tfd.fixture_id = sf.fixture_id and tfd.game_id = sf.game_id
  join teams t on t.id = tfd.team_id
  join teams ot on ot.id = (case when tfd.team_id = sf.home_team_id then sf.away_team_id else sf.home_team_id end)
  left join earliest_real_prob erp on erp.fixture_id = sf.fixture_id
  left join earliest_clean_sheet ecs on ecs.fixture_id = sf.fixture_id and ecs.team_id = tfd.team_id
  order by sf.kickoff_at, sf.fixture_id, is_home desc;
$$;
