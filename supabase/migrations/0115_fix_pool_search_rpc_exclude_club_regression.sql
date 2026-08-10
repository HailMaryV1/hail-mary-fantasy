-- Fixes a regression from the immediately-preceding migration (0114):
-- that migration rebuilt search_game_player_pool from the 0100 shape
-- (11 args) and lost the p_exclude_club parameter migration 0101 had
-- already added (EFL Fantasy's "Players" tab needs it to hide CLUB
-- rows, 12 args). Postgres treats a differing arg list as a genuinely
-- different overload, not a replacement - so 0114's "create or replace"
-- didn't touch the real 12-arg function at all, it just created a second,
-- incomplete overload alongside it (confirmed live - both existed after
-- 0114 ran). Dropping both here and creating the one correct version:
-- 12 args (p_exclude_club restored) plus 0114's real additions
-- (ownership_pct, 'price'/'owned' sort).
drop function if exists search_game_player_pool(text, integer, text, text, text, text, bigint[], numeric, text, integer, integer);
drop function if exists search_game_player_pool(text, integer, text, text, text, text, bigint[], numeric, text, boolean, integer, integer);

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
  p_exclude_club boolean default false,
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
  ownership_pct numeric,
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
      coalesce((s.inputs #>> '{reconciliation,bonus}')::numeric, 0) as bonus_projected,
      gpp.ownership_pct
    from game_player_pool gpp
    left join scored s on s.game_player_id = gpp.game_player_id
    where gpp.game_slug = p_game_slug
      and (p_position is null or gpp.position = p_position)
      and (not p_exclude_club or gpp.position <> 'CLUB')
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
      when 'price' then price
      when 'owned' then ownership_pct
      else hail_mary_score
    end desc nulls last,
    full_name asc
  limit p_limit offset p_offset;
$$;
