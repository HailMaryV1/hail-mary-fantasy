-- Adds points_per_90 to player_score_by_horizon's output - it's static
-- per player (from last season's history, unaffected by which fixtures
-- are in the averaging window), so any row in the range gives the same
-- value; included for the existing rankings-table column/sort rather
-- than needing a second query. Postgres requires dropping a table-
-- returning function before changing its output columns.

drop function player_score_by_horizon(text, int);

create function player_score_by_horizon(p_game_slug text, p_num_gameweeks int)
returns table (
    game_player_id bigint,
    full_name text,
    "position" text,
    team_name text,
    price numeric,
    avg_score numeric,
    points_per_90 numeric,
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
    round(avg((pr.inputs ->> 'points_per_90')::numeric), 2) as points_per_90,
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
