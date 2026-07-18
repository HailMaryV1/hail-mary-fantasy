-- player_score_by_horizon averaged raw `projections` rows directly,
-- without the "latest projection per gameweek wins" rule every other
-- projection-reading view already applies (see migration 0018's own fix
-- for the identical problem in player_projection_summary/_fixtures, and
-- game_player_pool's lateral-latest-only pick). It stayed invisible while
-- only one algorithm version ever existed per gameweek (a re-run just
-- updates the same row via its on-conflict upsert), but broke the moment
-- a genuinely new algorithm_version_id (v2-decomposed) got written
-- alongside old v1 rows for the same gameweeks that were never cleaned
-- up: avg_score silently blended both algorithms' scores together.
-- Caught by cross-checking a real player's on-page average against the
-- underlying rows, not assumed correct from the query looking reasonable -
-- same discipline as every other bug found this way in this codebase.

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
  ),
  latest_per_gw as (
    select distinct on (pr.game_player_id, pr.gameweek) pr.*
    from projections pr
    join game_players gp on gp.id = pr.game_player_id
    join fantasy_games fg on fg.id = gp.game_id
    cross join next_gw
    where fg.slug = p_game_slug
      and next_gw.gw is not null
      and pr.gameweek >= next_gw.gw
      and pr.gameweek < next_gw.gw + p_num_gameweeks
    order by pr.game_player_id, pr.gameweek, pr.created_at desc
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
    (select gw from next_gw)::int as start_gameweek
  from game_players gp
  join players p on p.id = gp.player_id
  join teams t on t.id = p.team_id
  join fantasy_games fg on fg.id = gp.game_id
  join latest_per_gw pr on pr.game_player_id = gp.id
  where fg.slug = p_game_slug
  group by gp.id, p.full_name, p.position, t.name, gp.price
  order by avg_score desc;
$$;

grant execute on function player_score_by_horizon(text, int) to anon, authenticated;
