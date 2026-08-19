-- Surface FFScout's real team-news signal (migration 0122, scripts/
-- capture_ffscout_player_status.py) in game_player_pool/search_game_
-- player_pool - 2026-08-19 user request: a visible red/orange badge in
-- the pool table and on the pitch (Dream Team, FanTeam, Cloud FF - EFL
-- Fantasy already has its own eflfantasy_status, no frontend change
-- planned there). The engine (compute_projections.py) already consumes
-- this data for scoring; this is the same signal, exposed for display.
--
-- Not gated to a specific fg.slug the way fanteam_status/eflfantasy_
-- status are - FFScout data is real-world/game-agnostic (keyed by
-- player_id, not game_player_id), so it naturally has no rows at all
-- for EFL Fantasy's Championship/League One/League Two players. Which
-- games actually RENDER this column is a frontend decision, not
-- something this view needs to encode.
--
-- Same "most recent row per player within an 8-day staleness window"
-- read pattern already used by compute_projections.py's fetch_ffscout_
-- player_status() - keeps this view's read logic identical to the
-- engine's own, so what a user sees always matches what scored them.
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
    gp.ownership_pct,
    real_stats.total_points as real_total_points,
    real_stats.appearances as real_appearances,
    real_stats.goals as real_goals,
    real_stats.assists as real_assists,
    real_stats.clean_sheets as real_clean_sheets,
    real_stats.saves as real_saves,
    real_stats.tackles as real_tackles,
    real_stats.clearances as real_clearances,
    real_stats.blocks as real_blocks,
    real_stats.interceptions as real_interceptions,
    real_stats.key_passes as real_key_passes,
    real_stats.shots_on_target as real_shots_on_target,
    last_result.gameweek as last_gw,
    last_result.actual_points as last_gw_points,
    ffscout.status as ffscout_status,
    ffscout.start_probability as ffscout_start_probability
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
left join lateral (
    select
        gps.total_points,
        coalesce((gps.raw_stats->>'appearances')::int, 0) as appearances,
        gps.goals, gps.assists, gps.clean_sheets, gps.saves,
        coalesce((gps.raw_stats->>'tackles')::int, 0) as tackles,
        coalesce((gps.raw_stats->>'clearances')::int, 0) as clearances,
        coalesce((gps.raw_stats->>'blocks')::int, 0) as blocks,
        coalesce((gps.raw_stats->>'interceptions')::int, 0) as interceptions,
        coalesce((gps.raw_stats->>'keyPasses')::int, 0) as key_passes,
        coalesce((gps.raw_stats->>'shotsOnTarget')::int, 0) as shots_on_target
    from game_player_stats gps
    where gps.game_player_id = gp.id and gps.gameweek = 0
    order by gps.created_at desc
    limit 1
) real_stats on true
left join lateral (
    select pgp.gameweek, pgp.actual_points
    from player_gameweek_predictions pgp
    where pgp.game_player_id = gp.id and pgp.actual_points is not null
    order by pgp.gameweek desc
    limit 1
) last_result on true
left join lateral (
    select s.status, s.start_probability
    from ffscout_player_status s
    where s.player_id = p.id and s.snapshot_date >= current_date - interval '8 days'
    order by s.snapshot_date desc, s.captured_at desc
    limit 1
) ffscout on true
where gp.is_active;

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
  real_total_points numeric,
  real_appearances int,
  real_goals int,
  real_assists int,
  real_clean_sheets int,
  real_saves int,
  real_tackles int,
  real_clearances int,
  real_blocks int,
  real_interceptions int,
  real_key_passes int,
  real_shots_on_target int,
  last_gw int,
  last_gw_points numeric,
  ffscout_status text,
  ffscout_start_probability numeric,
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
      gpp.ownership_pct,
      gpp.real_total_points, gpp.real_appearances, gpp.real_goals, gpp.real_assists,
      gpp.real_clean_sheets, gpp.real_saves, gpp.real_tackles, gpp.real_clearances,
      gpp.real_blocks, gpp.real_interceptions, gpp.real_key_passes, gpp.real_shots_on_target,
      gpp.last_gw, gpp.last_gw_points,
      gpp.ffscout_status, gpp.ffscout_start_probability
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
      when 'real_pts' then real_total_points
      when 'tackles' then real_tackles::numeric
      when 'clearances' then real_clearances::numeric
      when 'blocks' then real_blocks::numeric
      when 'interceptions' then real_interceptions::numeric
      when 'key_passes' then real_key_passes::numeric
      when 'shots_on_target' then real_shots_on_target::numeric
      when 'saves' then real_saves::numeric
      else hail_mary_score
    end desc nulls last,
    full_name asc
  limit p_limit offset p_offset;
$$;
