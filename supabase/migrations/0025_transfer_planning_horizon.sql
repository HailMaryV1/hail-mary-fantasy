-- player_score_by_horizon anchors itself to "the earliest gameweek with
-- any fixture still upcoming" - the right anchor for rankings/player
-- pages, but wrong for transfer *recommendations* once a gameweek has
-- partially started: it'd keep pointing at gameweek 1 (still has fixtures
-- left to play) instead of gameweek 2 (the next one you can actually still
-- transfer for). This variant takes the start gameweek as an explicit
-- parameter instead of computing it internally, so the caller can pass in
-- whichever gameweek transfers can still affect (see
-- frontend/src/lib/gameweek.ts's getSeasonTiming) - same "latest
-- projection per gameweek wins" dedup as the fixed player_score_by_horizon
-- (migration 0024), just parameterized.

create function player_score_by_horizon_from(p_game_slug text, p_start_gameweek int, p_num_gameweeks int)
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
  with latest_per_gw as (
    select distinct on (pr.game_player_id, pr.gameweek) pr.*
    from projections pr
    join game_players gp on gp.id = pr.game_player_id
    join fantasy_games fg on fg.id = gp.game_id
    where fg.slug = p_game_slug
      and pr.gameweek >= p_start_gameweek
      and pr.gameweek < p_start_gameweek + p_num_gameweeks
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
    p_start_gameweek::int as start_gameweek
  from game_players gp
  join players p on p.id = gp.player_id
  join teams t on t.id = p.team_id
  join fantasy_games fg on fg.id = gp.game_id
  join latest_per_gw pr on pr.game_player_id = gp.id
  where fg.slug = p_game_slug
  group by gp.id, p.full_name, p.position, t.name, gp.price
  order by avg_score desc;
$$;

grant execute on function player_score_by_horizon_from(text, int, int) to anon, authenticated;
