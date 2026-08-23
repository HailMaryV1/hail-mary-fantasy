-- Hail Mary Rating: a 1-10 within-position/gameweek/game percentile
-- rating derived from hail_mary_score, computed by compute_projections.py
-- (see assign_ratings/write_ratings) and stored alongside the raw score
-- it's derived from - not computed at read time, since ranking needs the
-- WHOLE position/gameweek/game pool at once, and storing it as a column
-- means every reader (bulk pool queries AND single-player lookups) gets
-- a cheap already-computed value with no extra subquery anywhere.
-- Nullable: existing/un-recomputed rows have no rating yet until the
-- next compute_projections.py run - never fake one.
alter table projections add column hail_mary_rating smallint
    check (hail_mary_rating is null or hail_mary_rating between 1 and 10);

-- Both views below are byte-identical to migration 0129's versions except
-- for the added hail_mary_rating column, following the same
-- coalesce(current-gameweek-row, latest-row) fallback already used for
-- hail_mary_score.
create or replace view player_projection_summary as
select
    fg.slug as game_slug,
    p.full_name,
    gp.position_code as position,
    t.name as team_name,
    gp.price,
    pr.hail_mary_score,
    pr.period_start,
    pr.period_end,
    (pr.inputs->>'points_per_90')::numeric as points_per_90,
    pr.algorithm_version_id,
    gp.id as game_player_id,
    pr.gameweek,
    pr.inputs,
    -- Appended at the end, not inline after hail_mary_score - CREATE OR
    -- REPLACE VIEW can only append new columns, not insert mid-list
    -- (confirmed live: "cannot change name of view column ... to
    -- hail_mary_rating" the first time this was tried inline).
    pr.hail_mary_rating
from game_players gp
join players p on p.id = gp.player_id
join teams t on t.id = p.team_id
join fantasy_games fg on fg.id = gp.game_id
left join lateral (
    select gfg.gameweek
    from game_fixture_gameweeks gfg
    join fixtures f on f.id = gfg.fixture_id
    where gfg.game_id = gp.game_id
    group by gfg.gameweek
    having min(f.kickoff_at) >= now()
    order by gfg.gameweek asc
    limit 1
) current_gw on true
join lateral (
    select
        pr_1.id,
        pr_1.algorithm_version_id,
        pr_1.game_player_id,
        pr_1.season,
        pr_1.gameweek,
        pr_1.hail_mary_score,
        pr_1.hail_mary_rating,
        pr_1.inputs,
        pr_1.created_at,
        pr_1.period_start,
        pr_1.period_end
    from projections pr_1
    where pr_1.game_player_id = gp.id
    order by (not pr_1.gameweek is distinct from current_gw.gameweek) desc, pr_1.created_at desc
    limit 1
) pr on true
where gp.is_active = true;

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
    real_stats.minutes_played as real_minutes_played,
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
    ffscout.start_probability as ffscout_start_probability,
    rotation.start_probability as rotation_start_probability,
    rotation.contender_name as rotation_contender_name,
    rotation.contender_probability as rotation_contender_probability,
    rotation.risk_level as rotation_risk_level,
    ffscout_detail.detail as ffscout_detail,
    ffscout_detail.expected_return_date as ffscout_expected_return_date,
    real_stats.season as real_season,
    -- Appended at the end - same CREATE OR REPLACE VIEW append-only
    -- constraint as player_projection_summary above.
    coalesce(proj_for_current_gw.hail_mary_rating, proj_fallback.hail_mary_rating) as hail_mary_rating
from game_players gp
join players p on p.id = gp.player_id
join teams t on t.id = p.team_id
join fantasy_games fg on fg.id = gp.game_id
left join lateral (
    select gfg.gameweek
    from game_fixture_gameweeks gfg
    join fixtures f on f.id = gfg.fixture_id
    where gfg.game_id = gp.game_id
    group by gfg.gameweek
    having min(f.kickoff_at) >= now()
    order by gfg.gameweek asc
    limit 1
) current_gw on true
left join lateral (
    select pr.hail_mary_score, pr.hail_mary_rating
    from projections pr
    where pr.game_player_id = gp.id
      and pr.gameweek is not distinct from current_gw.gameweek
    order by pr.created_at desc
    limit 1
) proj_for_current_gw on true
left join lateral (
    select pr.hail_mary_score, pr.hail_mary_rating
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
        gps.season,
        gps.minutes_played,
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
left join lateral (
    select s.detail, s.expected_return_date
    from ffscout_player_status s
    where s.player_id = p.id and s.snapshot_date >= current_date - interval '8 days'
      and s.detail is not null
    order by s.snapshot_date desc, s.captured_at desc
    limit 1
) ffscout_detail on true
left join lateral (
    select r.start_probability, r.contender_name, r.contender_probability, r.risk_level
    from player_rotation_risk r
    where r.player_id = p.id
      and (select max(l.snapshot_date) from player_lineup_probability_latest l) >= current_date - interval '30 days'
) rotation on true
where gp.is_active;

-- search_game_player_pool's RETURNS TABLE shape changes (new column) -
-- CREATE OR REPLACE can't do that, same drop-then-create pattern as
-- migrations 0118/0130. Body is byte-identical to 0130's version except
-- for hail_mary_rating threaded through both CTEs and the default sort
-- branch changing from raw score to rating-primary/score-tiebreak - Ask
-- Mary and the pool table should both prefer the highest-RATED players,
-- not just the highest-scoring ones (raw score stays the tiebreak for
-- players who land in the same rating bucket).
drop function if exists search_game_player_pool(text, integer, text, text, text, text, bigint[], numeric, text, boolean, integer, integer);

create function search_game_player_pool(
    p_game_slug text,
    p_gameweek integer,
    p_position text default null,
    p_team_name text default null,
    p_competition text default null,
    p_search text default null,
    p_exclude_ids bigint[] default '{}',
    p_max_price numeric default null,
    p_sort_by text default 'pts',
    p_exclude_club boolean default false,
    p_limit integer default 15,
    p_offset integer default 0
)
returns table(
    game_player_id bigint, full_name text, "position" text, team_id bigint, team_name text,
    price numeric, competition text, hail_mary_score numeric, hail_mary_rating smallint, goal_projected numeric,
    assist_projected numeric, bonus_projected numeric, ownership_pct numeric,
    real_total_points numeric, real_minutes_played integer, real_goals integer, real_assists integer,
    real_clean_sheets integer, real_saves integer, real_tackles integer, real_clearances integer,
    real_blocks integer, real_interceptions integer, real_key_passes integer, real_shots_on_target integer,
    last_gw integer, last_gw_points numeric,
    ffscout_status text, ffscout_start_probability numeric, ffscout_detail text, ffscout_expected_return_date date,
    rotation_start_probability numeric, rotation_contender_name text, rotation_contender_probability numeric,
    rotation_risk_level text, total_count bigint
)
language sql stable as $$
  with scored as (
    select distinct on (pr.game_player_id) pr.game_player_id, pr.hail_mary_score, pr.hail_mary_rating, pr.inputs
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
      coalesce(s.hail_mary_rating, gpp.hail_mary_rating) as hail_mary_rating,
      coalesce((s.inputs #>> '{fixtures,0,stats,goal,projected}')::numeric, 0) as goal_projected,
      coalesce((s.inputs #>> '{fixtures,0,stats,assist,projected}')::numeric, 0) as assist_projected,
      coalesce((s.inputs #>> '{reconciliation,bonus}')::numeric, 0) as bonus_projected,
      gpp.ownership_pct,
      gpp.real_total_points, gpp.real_minutes_played, gpp.real_goals, gpp.real_assists,
      gpp.real_clean_sheets, gpp.real_saves, gpp.real_tackles, gpp.real_clearances,
      gpp.real_blocks, gpp.real_interceptions, gpp.real_key_passes, gpp.real_shots_on_target,
      gpp.last_gw, gpp.last_gw_points,
      gpp.ffscout_status, gpp.ffscout_start_probability,
      gpp.ffscout_detail, gpp.ffscout_expected_return_date,
      gpp.rotation_start_probability, gpp.rotation_contender_name,
      gpp.rotation_contender_probability, gpp.rotation_risk_level
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
      -- Default ('pts', unchanged wire value) now sorts by rating first -
      -- matches Ask Mary/the pool table preferring the highest-RATED
      -- player, not just the highest-scoring one.
      else coalesce(hail_mary_rating, 0)::numeric
    end desc nulls last,
    -- Raw score as an always-present second key: the tiebreak within a
    -- tied rating bucket for the default sort, and a reasonable tiebreak
    -- for every other sort mode too (e.g. two players tied on goals now
    -- break by score instead of arbitrary row order).
    hail_mary_score desc nulls last,
    full_name asc
  limit p_limit offset p_offset;
$$;

-- Hail Mary Weekly Ratings page: top-N rated players per position for one
-- (game, gameweek) - a purpose-built RPC rather than a repurposing of
-- search_game_player_pool (that one returns a single flat sorted/
-- paginated list, not top-N-per-group). Reads game_player_pool directly
-- so it shares that view's own current-gameweek/fallback logic and needs
-- no separate gameweek-resolution code.
create function get_top_rated_players(
    p_game_slug text,
    p_gameweek integer,
    p_limit integer default 5
)
returns table(
    "position" text, rnk integer, game_player_id bigint, full_name text,
    team_id bigint, team_name text, hail_mary_rating smallint, hail_mary_score numeric
)
language sql stable as $$
  with scored as (
    select distinct on (pr.game_player_id) pr.game_player_id, pr.hail_mary_score, pr.hail_mary_rating
    from projections pr
    join game_players gp on gp.id = pr.game_player_id
    join fantasy_games fg on fg.id = gp.game_id
    where fg.slug = p_game_slug and pr.gameweek = p_gameweek
    order by pr.game_player_id, pr.created_at desc, pr.id desc
  ),
  ranked as (
    select
      gpp.position,
      row_number() over (
        partition by gpp.position
        order by coalesce(s.hail_mary_rating, gpp.hail_mary_rating) desc nulls last,
                  coalesce(s.hail_mary_score, gpp.hail_mary_score) desc nulls last
      ) as rnk,
      gpp.game_player_id, gpp.full_name, gpp.team_id, gpp.team_name,
      coalesce(s.hail_mary_rating, gpp.hail_mary_rating) as hail_mary_rating,
      coalesce(s.hail_mary_score, gpp.hail_mary_score) as hail_mary_score
    from game_player_pool gpp
    left join scored s on s.game_player_id = gpp.game_player_id
    where gpp.game_slug = p_game_slug
  )
  select position, rnk, game_player_id, full_name, team_id, team_name, hail_mary_rating, hail_mary_score
  from ranked
  where rnk <= p_limit
  order by position, rnk;
$$;
