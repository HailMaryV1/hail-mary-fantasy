-- search_target_score_pool: the Target Score equivalent of
-- search_game_player_pool (migration 0135) - a paginated, filterable
-- browse over the RATED pool for a given horizon, not just the top-5
-- per position get_top_target_score_players returns. Real user request
-- 2026-08-26: "I should be able to check boxes that narrows the players
-- down to what im after... Like a 9 or 10 rated defender for the next 3
-- gameweeks that is under 20% owned" + "also add the price points too -
-- so player at under 3.5m etc".
--
-- A NEW, separate RPC rather than extending search_game_player_pool in
-- place - that RPC is shared by every squad board's own pool tab
-- (dreamteam/fanteam/cloudff/eflfantasy), a much larger blast radius
-- than this page alone, and its single-gameweek shape doesn't fit a
-- multi-gameweek horizon window anyway (same reasoning
-- get_top_target_score_players was already kept separate from
-- get_top_rated_players for). The gameweek/horizon here should be
-- whatever the page's own horizon pills already resolved (anchorGameweek
-- in ratings/page.tsx) - this RPC doesn't re-derive it.
--
-- The INNER join to target_scores is deliberate, same as get_top_
-- target_score_players: this section's own subtitle already says
-- "the full RATED pool" - a player with no real rating at this horizon
-- (fails is_rating_eligible) has nothing to browse here, consistent
-- with the rest of this feature's "no rubbish" rule, not a new
-- restriction invented for this RPC alone.
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
  with scored as (
    select distinct on (pr.game_player_id) pr.game_player_id, pr.hail_mary_rating
    from projections pr
    join game_players gp on gp.id = pr.game_player_id
    join fantasy_games fg on fg.id = gp.game_id
    where fg.slug = p_game_slug and pr.gameweek = p_gameweek
    order by pr.game_player_id, pr.created_at desc, pr.id desc
  ),
  base as (
    select
      gpp.game_player_id, gpp.full_name, gpp.position, gpp.team_id, gpp.team_name,
      gpp.price, gpp.ownership_pct, gpp.real_total_points,
      case when p_horizon = 1 then s.hail_mary_rating else round(ts.target_score)::smallint end as displayed_rating,
      ts.form_rating, ts.fixture_difficulty_rating, ts.fixture_quantity_rating, ts.live_odds_rating,
      ts.inputs -> 'window_fixtures' as window_fixtures,
      ts.end_gameweek
    from scored s
    join game_player_pool gpp on gpp.game_player_id = s.game_player_id and gpp.game_slug = p_game_slug
    join target_scores ts on ts.game_player_id = s.game_player_id and ts.horizon = p_horizon and ts.start_gameweek = p_gameweek
    where (p_position is null or gpp.position = p_position)
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
