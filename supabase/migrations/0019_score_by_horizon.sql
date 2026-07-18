-- Powers the Short/Medium/Long toggle on the rankings page: average
-- Hail Mary Score over the next N gameweeks from "now", for transfer
-- planning at different time horizons. Only works for games with a
-- real gameweek calendar (currently FanTeam only - see migration 0016);
-- for games without one, "next gameweek" resolves to null and this
-- returns no rows, which the frontend treats as "not available yet"
-- rather than erroring.
--
-- The average is a plain AVG() over whichever gameweeks in the window
-- actually have a projection row - NOT divided by the fixed window
-- size. A player missing from one of the 3 requested gameweeks (no
-- fixture that week, a genuine blank) is averaged over the gameweeks
-- they DO have, not penalized with an implicit zero. gameweeks_included
-- is returned so the frontend can show when fewer than requested
-- actually contributed, rather than that being silently invisible.

create or replace function player_score_by_horizon(p_game_slug text, p_num_gameweeks int)
returns table (
    game_player_id bigint,
    full_name text,
    "position" text,
    team_name text,
    price numeric,
    avg_score numeric,
    gameweeks_included int,
    start_gameweek int
)
language sql
stable
as $$
  with next_gw as (
    select min(gfg.gameweek) as gw
    from game_fixture_gameweeks gfg
    join fixtures f on f.id = gfg.fixture_id
    join fantasy_games fg on fg.id = gfg.game_id
    where fg.slug = p_game_slug and f.kickoff_at >= now()
  )
  select
    gp.id as game_player_id,
    p.full_name,
    p.position,
    t.name as team_name,
    gp.price,
    round(avg(pr.hail_mary_score), 2) as avg_score,
    count(pr.gameweek)::int as gameweeks_included,
    next_gw.gw::int as start_gameweek
  from game_players gp
  join players p on p.id = gp.player_id
  join teams t on t.id = p.team_id
  join fantasy_games fg on fg.id = gp.game_id
  join projections pr on pr.game_player_id = gp.id
  cross join next_gw
  where fg.slug = p_game_slug
    and next_gw.gw is not null
    and pr.gameweek >= next_gw.gw
    and pr.gameweek < next_gw.gw + p_num_gameweeks
  group by gp.id, p.full_name, p.position, t.name, gp.price, next_gw.gw
  order by avg_score desc;
$$;

grant execute on function player_score_by_horizon(text, int) to anon, authenticated;
