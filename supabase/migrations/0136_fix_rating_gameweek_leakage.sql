-- Fix: hail_mary_rating leaking across gameweeks in the two functions
-- that take an explicit p_gameweek (search_game_player_pool,
-- get_top_rated_players). Both mirrored the existing
-- coalesce(this-gameweek, game_player_pool's-current-or-latest) pattern
-- already used for hail_mary_score - a reasonable fallback for score
-- (a smoothly-comparable absolute number, fine to approximate with a
-- nearby gameweek's value), but wrong for rating: rating is a WITHIN-
-- GAMEWEEK percentile rank, only meaningful relative to the OTHER
-- players scored in that exact gameweek. Falling back to
-- game_player_pool's own "current gameweek" rating when viewing an
-- unrated gameweek (e.g. GW1 before its own recompute has run) silently
-- pairs that gameweek's real score with a DIFFERENT gameweek's rank -
-- internally inconsistent, and looked like "everyone's 10/10 regardless
-- of their real projection" when spotted live (2026-08-23 user report on
-- the new Hail Mary Weekly Ratings page). Fix: hail_mary_rating now only
-- ever comes from the exact requested gameweek's own projections row -
-- null (never a borrowed number) until that gameweek's own
-- compute_projections.py run has written it. Matches this project's
-- existing "absence of data is never treated as a real value" rule.

create or replace function search_game_player_pool(
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
      -- No coalesce fallback here - see this migration's header comment.
      s.hail_mary_rating as hail_mary_rating,
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
      else coalesce(hail_mary_rating, 0)::numeric
    end desc nulls last,
    hail_mary_score desc nulls last,
    full_name asc
  limit p_limit offset p_offset;
$$;

-- get_top_rated_players restructured to INNER join scored -> game_player_pool
-- (was LEFT join game_player_pool -> scored) - a player with no
-- projections row for the exact requested gameweek simply isn't a
-- candidate for "top rated players THIS gameweek" at all, rather than
-- leaking in with a different gameweek's score/rating via game_player_pool's
-- own current-gameweek fallback.
create or replace function get_top_rated_players(
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
        order by s.hail_mary_rating desc nulls last, s.hail_mary_score desc nulls last
      ) as rnk,
      gpp.game_player_id, gpp.full_name, gpp.team_id, gpp.team_name,
      s.hail_mary_rating,
      s.hail_mary_score
    from scored s
    join game_player_pool gpp on gpp.game_player_id = s.game_player_id and gpp.game_slug = p_game_slug
  )
  select position, rnk, game_player_id, full_name, team_id, team_name, hail_mary_rating, hail_mary_score
  from ranked
  where rnk <= p_limit
  order by position, rnk;
$$;
