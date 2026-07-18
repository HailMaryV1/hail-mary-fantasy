-- player_projection_fixtures (migration 0018) always shows whichever single
-- projection was most recently computed for a player - not necessarily the
-- next upcoming gameweek, and never more than one gameweek's fixtures. That
-- made the player detail page silently disconnected from the rankings
-- page's Short/Medium/Long horizon toggle: clicking a player from "Medium
-- (2 GW avg)" showed a one-fixture breakdown that didn't add up to the
-- score you just saw. This mirrors player_score_by_horizon's own logic
-- (same "next published gameweek onward" anchor) but returns the
-- per-fixture rows for ONE player across the whole window, latest
-- projection per gameweek (same "latest wins" rule as every other
-- projection-reading view here, in case an old algorithm version's row is
-- still sitting in the table next to a newer one for the same gameweek).
--
-- stats is included straight from inputs->'stats' for v2-decomposed rows
-- (null for v1/games with no scoring matrix) - the frontend can render the
-- per-stat breakdown when present.

create function player_projection_fixtures_by_horizon(p_game_player_id bigint, p_num_gameweeks int)
returns table (
    projection_id bigint,
    gameweek int,
    fixture_id bigint,
    kickoff_at timestamptz,
    opponent text,
    is_home boolean,
    attack_score numeric,
    clean_sheet_score numeric,
    fixture_factor numeric,
    contribution numeric,
    stats jsonb
)
language sql
stable
as $$
  with player_game as (
    select gp.game_id, p.team_id
    from game_players gp
    join players p on p.id = gp.player_id
    where gp.id = p_game_player_id
  ),
  next_gw as (
    select min(gfg.gameweek) as gw
    from game_fixture_gameweeks gfg
    join fixtures f on f.id = gfg.fixture_id
    cross join player_game pg
    where gfg.game_id = pg.game_id and f.kickoff_at >= now()
  ),
  latest_per_gw as (
    select distinct on (pr.gameweek) pr.*
    from projections pr
    where pr.game_player_id = p_game_player_id
      and pr.gameweek >= (select gw from next_gw)
      and pr.gameweek < (select gw from next_gw) + p_num_gameweeks
    order by pr.gameweek, pr.created_at desc
  )
  select
    lpg.id as projection_id,
    lpg.gameweek,
    (fx.value ->> 'fixture_id')::bigint as fixture_id,
    f.kickoff_at,
    case when f.home_team_id = pg.team_id then away_t.name else home_t.name end as opponent,
    (f.home_team_id = pg.team_id) as is_home,
    (fx.value ->> 'attack_score')::numeric as attack_score,
    (fx.value ->> 'clean_sheet_score')::numeric as clean_sheet_score,
    (fx.value ->> 'fixture_factor')::numeric as fixture_factor,
    (fx.value ->> 'contribution')::numeric as contribution,
    fx.value -> 'stats' as stats
  from latest_per_gw lpg
  cross join lateral jsonb_array_elements(lpg.inputs -> 'fixtures') as fx(value)
  cross join player_game pg
  join fixtures f on f.id = (fx.value ->> 'fixture_id')::bigint
  join teams home_t on home_t.id = f.home_team_id
  join teams away_t on away_t.id = f.away_team_id
  order by lpg.gameweek, f.kickoff_at;
$$;

grant execute on function player_projection_fixtures_by_horizon(bigint, int) to anon, authenticated;
