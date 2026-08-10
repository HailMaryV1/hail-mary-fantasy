-- Live ownership percentage (2026-08-10 user request). Confirmed live on
-- two of the 4 real platforms while investigating this:
--   - EFL Fantasy: players.json's own "percentSelected" field (confirmed
--     live, meaningfully populated - e.g. K. Trippier at 55.6%, not a
--     placeholder).
--   - Cloud FF: getPlayerStats' own "Ownership" field (confirmed live -
--     e.g. Haaland at 92.8% - already fetched by other scripts for other
--     stats, never previously persisted as ownership).
-- Dream Team and FanTeam have no such field on their real feeds
-- (FanTeam's absence already documented in swingOpportunity.ts; Dream
-- Team's scraper has no equivalent) - ownership_pct stays null there,
-- same "absence of data is never treated as a real value" convention
-- used everywhere else in this schema (see game_player_pool's own
-- docstring).
--
-- Lives directly on game_players, same home as price - a live, per-
-- game-player attribute, not a player-identity or team-scoped one.
alter table game_players add column ownership_pct numeric null;

create or replace view game_player_pool as
select
    fg.slug as game_slug,
    gp.id as game_player_id,
    p.full_name,
    gp.position_code as position,
    t.id as team_id,
    t.name as team_name,
    gp.price,
    coalesce(proj_for_current_gw.hail_mary_score, proj_fallback.hail_mary_score) as hail_mary_score,
    fanteam_status.lineup,
    coalesce(fanteam_status.status, eflfantasy_status.status) as status,
    fanteam_status.form,
    gp.competition,
    p.id as player_id,
    gp.ownership_pct
from game_players gp
join players p on p.id = gp.player_id
join teams t on t.id = p.team_id
join fantasy_games fg on fg.id = gp.game_id
left join lateral (
    select gfg.gameweek
    from game_fixture_gameweeks gfg
    join fixtures f on f.id = gfg.fixture_id
    where gfg.game_id = gp.game_id and f.kickoff_at >= now()
    order by gfg.gameweek asc, f.kickoff_at asc
    limit 1
) current_gw on true
left join lateral (
    select pr.hail_mary_score
    from projections pr
    where pr.game_player_id = gp.id
      and pr.gameweek is not distinct from current_gw.gameweek
    order by pr.created_at desc
    limit 1
) proj_for_current_gw on true
left join lateral (
    select pr.hail_mary_score
    from projections pr
    where pr.game_player_id = gp.id
    order by pr.created_at desc
    limit 1
) proj_fallback on true
left join lateral (
    select s.lineup, s.status, s.form
    from fanteam_player_status s
    where s.game_player_id = gp.id and fg.slug = 'fanteam'
    order by s.gameweek desc, s.scraped_at desc
    limit 1
) fanteam_status on true
left join lateral (
    select s.status
    from eflfantasy_player_status s
    where s.game_player_id = gp.id and fg.slug = 'eflfantasy'
    order by s.gameweek desc, s.scraped_at desc
    limit 1
) eflfantasy_status on true
where gp.is_active;

-- Extends search_game_player_pool (migrations 0099/0100) with 'price' and
-- 'owned' sort options plus ownership_pct in the return shape. 'price'
-- makes sense for every game except EFL Fantasy (no budget at all -
-- game_players.price is always the 0 sentinel there, see migration
-- 0089's docstring) - the frontend simply never offers that option on
-- EFL's board, same as ownership only being offered where real data
-- exists (see gameConfig.ts wiring).
drop function if exists search_game_player_pool(text, integer, text, text, text, text, bigint[], numeric, text, integer, integer);

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
