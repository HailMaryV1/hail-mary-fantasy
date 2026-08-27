-- Site-wide rating consolidation (2026-08-27): target_score becomes the
-- ONLY player-quality rating shown anywhere, for every horizon including
-- "this gameweek" - real user direction, confirmed after the old
-- hail_mary_rating (a percentile rank within position/gameweek, no
-- absolute anchor) was found to be exactly why a backup goalkeeper with
-- a brutal fixture could rate 9-10: it only ever answers "who's best
-- available this week", never "how good is this, really".
--
-- Both RPCs below special-cased p_horizon = 1 to rank/display
-- hail_mary_rating instead of target_score - a leftover from before
-- Target Score existed for a single gameweek at all. compute_target_
-- scores.py already computes a real target_scores row at horizon=1 (see
-- its own HORIZONS tuple), so there's no longer a reason for that
-- special case - dropping it here is what actually makes today's
-- compute_target_scores.py absolute-rating-scale fix visible on the
-- default "This gameweek" view, not just horizon>=2.
drop function if exists get_top_target_score_players(text, integer, integer, integer);

create function get_top_target_score_players(
    p_game_slug text,
    p_gameweek integer,
    p_horizon integer default 1,
    p_limit integer default 5
)
returns table(
    "position" text, rnk integer, game_player_id bigint, full_name text,
    team_id bigint, team_name text,
    target_score numeric,
    form_rating smallint, fixture_difficulty_rating smallint,
    fixture_quantity_rating smallint, live_odds_rating smallint,
    end_gameweek int,
    opponent_team_name text, fixture_is_home boolean, fixture_kickoff_at timestamptz,
    window_fixtures jsonb,
    last_gw int, last_gw_points numeric
)
language sql stable as $$
  with scored as (
    select distinct on (pr.game_player_id) pr.game_player_id, pr.hail_mary_score, pr.inputs
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
        order by ts.target_score desc nulls last, s.hail_mary_score desc nulls last
      ) as rnk,
      gpp.game_player_id, gpp.full_name, gpp.team_id, gpp.team_name,
      ts.target_score,
      ts.form_rating,
      ts.fixture_difficulty_rating,
      ts.fixture_quantity_rating,
      ts.live_odds_rating,
      ts.end_gameweek,
      opp_team.name as opponent_team_name,
      (fx.home_team_id = gpp.team_id) as fixture_is_home,
      fx.kickoff_at as fixture_kickoff_at,
      ts.inputs -> 'window_fixtures' as window_fixtures,
      gpp.last_gw,
      gpp.last_gw_points
    from scored s
    join game_player_pool gpp on gpp.game_player_id = s.game_player_id and gpp.game_slug = p_game_slug
    join target_scores ts on ts.game_player_id = s.game_player_id and ts.horizon = p_horizon and ts.start_gameweek = p_gameweek
    left join lateral (
      select f2.home_team_id, f2.away_team_id, f2.kickoff_at,
        case when f2.home_team_id = gpp.team_id then f2.away_team_id else f2.home_team_id end as opponent_team_id
      from fixtures f2
      where f2.id = (s.inputs #>> '{fixtures,0,fixture_id}')::bigint
    ) fx on true
    left join teams opp_team on opp_team.id = fx.opponent_team_id
  )
  select position, rnk, game_player_id, full_name, team_id, team_name,
    target_score, form_rating, fixture_difficulty_rating,
    fixture_quantity_rating, live_odds_rating, end_gameweek,
    opponent_team_name, fixture_is_home, fixture_kickoff_at,
    window_fixtures, last_gw, last_gw_points
  from ranked
  where rnk <= p_limit
  order by position, rnk;
$$;

-- Same fix, same reasoning - displayed_rating/sorting no longer special-
-- cases p_horizon = 1 to hail_mary_rating.
drop function if exists search_target_score_pool(text, integer, integer, text, text, text, integer, integer, numeric, numeric, numeric, numeric, text, boolean, integer, integer);

create function search_target_score_pool(
    p_game_slug text,
    p_gameweek integer,
    p_horizon integer default 1,
    p_position text default null,
    p_team_name text default null,
    p_search text default null,
    p_min_rating integer default null,
    p_max_rating integer default null,
    p_min_owned numeric default null,
    p_max_owned numeric default null,
    p_min_price numeric default null,
    p_max_price numeric default null,
    p_sort_by text default 'rating',
    p_exclude_club boolean default false,
    p_limit integer default 20,
    p_offset integer default 0
)
returns table(
    game_player_id bigint, full_name text, "position" text, team_id bigint, team_name text,
    price numeric, ownership_pct numeric,
    displayed_rating smallint,
    form_rating smallint, fixture_difficulty_rating smallint, fixture_quantity_rating smallint, live_odds_rating smallint,
    real_total_points numeric,
    window_fixtures jsonb, end_gameweek int,
    total_count bigint
)
language sql stable as $$
  with base as (
    select
      gpp.game_player_id, gpp.full_name, gpp.position, gpp.team_id, gpp.team_name,
      gpp.price, gpp.ownership_pct,
      round(ts.target_score)::smallint as displayed_rating,
      ts.form_rating, ts.fixture_difficulty_rating, ts.fixture_quantity_rating, ts.live_odds_rating,
      gpp.real_total_points,
      ts.inputs -> 'window_fixtures' as window_fixtures,
      ts.end_gameweek
    from game_player_pool gpp
    join target_scores ts on ts.game_player_id = gpp.game_player_id and ts.horizon = p_horizon and ts.start_gameweek = p_gameweek
    where gpp.game_slug = p_game_slug
      and (p_position is null or gpp.position = p_position)
      and (not p_exclude_club or gpp.position <> 'CLUB')
      and (p_team_name is null or gpp.team_name = p_team_name)
      and (p_search is null or p_search = '' or gpp.full_name ilike '%' || p_search || '%')
      and (p_min_owned is null or gpp.ownership_pct >= p_min_owned)
      and (p_max_owned is null or gpp.ownership_pct <= p_max_owned)
      and (p_min_price is null or gpp.price >= p_min_price)
      and (p_max_price is null or gpp.price <= p_max_price)
  ),
  filtered as (
    select * from base
    where (p_min_rating is null or displayed_rating >= p_min_rating)
      and (p_max_rating is null or displayed_rating <= p_max_rating)
  )
  select *, count(*) over() as total_count
  from filtered
  order by
    case p_sort_by
      when 'owned' then ownership_pct
      when 'price' then price
      when 'real_pts' then real_total_points
      else coalesce(displayed_rating, 0)::numeric
    end desc nulls last,
    full_name asc
  limit p_limit offset p_offset;
$$;
