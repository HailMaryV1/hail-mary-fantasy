-- Extends search_game_player_pool (migration 0099): every board's pool
-- table has a real "Sort by Goals/Assists/Bonus" dropdown that reads
-- goalProjected/assistProjected/bonusProjected off each pool row - values
-- pulled from the same projections.inputs JSON blob the score itself
-- already comes from (see compute_projections.py's decomposed-scoring
-- output), not a separate source. 0099 only carried hail_mary_score
-- through, silently breaking that sort. Also moves sorting server-side
-- (p_sort_by) - now that only one page is ever fetched, sorting client-
-- side after the fact would just sort whatever 15 rows happened to load,
-- not the real top-N across the whole filtered pool.
create or replace function search_game_player_pool(
  p_game_slug text,
  p_gameweek int,
  p_position text default null,
  p_team_name text default null,
  p_competition text default null,
  p_search text default null,
  p_exclude_ids bigint[] default '{}',
  p_max_price numeric default null,
  p_sort_by text default 'pts',
  p_limit int default 15,
  p_offset int default 0
)
returns table (
  game_player_id bigint,
  full_name text,
  "position" text,
  team_id bigint,
  team_name text,
  price numeric,
  competition text,
  hail_mary_score numeric,
  goal_projected numeric,
  assist_projected numeric,
  bonus_projected numeric,
  total_count bigint
)
language sql stable
as $$
  with scored as (
    select distinct on (pr.game_player_id) pr.game_player_id, pr.hail_mary_score, pr.inputs
    from projections pr
    join game_players gp on gp.id = pr.game_player_id
    join fantasy_games fg on fg.id = gp.game_id
    where fg.slug = p_game_slug and pr.gameweek = p_gameweek
    order by pr.game_player_id, pr.created_at desc, pr.id desc
  ),
  base as (
    select
      gpp.game_player_id, gpp.full_name, gpp.position, gpp.team_id, gpp.team_name,
      gpp.price, gpp.competition,
      coalesce(s.hail_mary_score, gpp.hail_mary_score) as hail_mary_score,
      coalesce((s.inputs #>> '{fixtures,0,stats,goal,projected}')::numeric, 0) as goal_projected,
      coalesce((s.inputs #>> '{fixtures,0,stats,assist,projected}')::numeric, 0) as assist_projected,
      coalesce((s.inputs #>> '{reconciliation,bonus}')::numeric, 0) as bonus_projected
    from game_player_pool gpp
    left join scored s on s.game_player_id = gpp.game_player_id
    where gpp.game_slug = p_game_slug
      and (p_position is null or gpp.position = p_position)
      and (p_team_name is null or gpp.team_name = p_team_name)
      and (p_competition is null or gpp.competition = p_competition)
      and (p_search is null or p_search = '' or gpp.full_name ilike '%' || p_search || '%')
      and (p_max_price is null or gpp.price <= p_max_price)
      and not (gpp.game_player_id = any(p_exclude_ids))
  )
  select *, count(*) over() as total_count
  from base
  order by
    case p_sort_by
      when 'goals' then goal_projected
      when 'assists' then assist_projected
      when 'bonus' then bonus_projected
      else hail_mary_score
    end desc nulls last,
    full_name asc
  limit p_limit offset p_offset;
$$;
