-- Server-side, paginated player/club pool search - replaces the pattern
-- every squad board page used until now: fetch the ENTIRE pool
-- (game_player_pool has no per-game row cap of its own, and EFL Fantasy's
-- combined players+clubs pool is ~3,458 rows) and filter/sort/paginate it
-- in the browser. That meant every page load - and every filter click,
-- once the gameweek switcher started letting users browse non-"current"
-- weeks - paid the cost of fetching, over the wire, thousands of rows
-- nobody was about to look at (the pool table only ever shows 15 at a
-- time). Confirmed live as a real, measurable chunk of EFL Fantasy's
-- board page load.
--
-- These two functions do the filtering, per-gameweek score lookup, and
-- pagination entirely in Postgres, returning only the requested page (a
-- handful of rows) plus a true total count via a window function, in one
-- round trip. game_player_pool's own hail_mary_score column always
-- reflects whichever gameweek is currently "live" (see its view
-- definition) - not necessarily the gameweek actually being browsed - so
-- search_game_player_pool looks the real per-gameweek score up from
-- projections itself (same "latest row per player" tie-break
-- getProjectionsForGameweek already uses client-side), falling back to
-- game_player_pool's score only when that gameweek hasn't been computed
-- at all yet.

create or replace function search_game_player_pool(
  p_game_slug text,
  p_gameweek int,
  p_position text default null,
  p_team_name text default null,
  p_competition text default null,
  p_search text default null,
  p_exclude_ids bigint[] default '{}',
  p_max_price numeric default null,
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
  total_count bigint
)
language sql stable
as $$
  with scored as (
    select distinct on (pr.game_player_id) pr.game_player_id, pr.hail_mary_score
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
      coalesce(s.hail_mary_score, gpp.hail_mary_score) as hail_mary_score
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
  order by hail_mary_score desc nulls last, full_name asc
  limit p_limit offset p_offset;
$$;

-- Distinct real club names for a game's pool filter dropdown - cheap
-- (tens of rows, not thousands) and independent of position/search/page,
-- so the frontend fetches this once per board load rather than deriving
-- it from the full pool it no longer holds in memory.
create or replace function list_game_pool_teams(p_game_slug text)
returns table (team_name text)
language sql stable
as $$
  select distinct gpp.team_name
  from game_player_pool gpp
  where gpp.game_slug = p_game_slug
  order by gpp.team_name;
$$;
