-- Bug fix (caught before shipping - direct test call showed displayed_
-- rating always null while real_total_points showed a rating-looking
-- small integer): a `language sql` table function matches its query's
-- output columns to RETURNS TABLE's declared list POSITIONALLY, not by
-- name. 0147's `base` CTE selected real_total_points right after
-- ownership_pct, but the declared table put it after live_odds_rating -
-- every column from that point on was silently shifted one position,
-- with Postgres coercing each mismatched value into whatever type the
-- wrong slot declared (displayed_rating smallint silently swallowed
-- real_total_points instead). Same function, same signature - just the
-- base CTE's column order corrected to match RETURNS TABLE exactly.
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
      gpp.price, gpp.ownership_pct,
      case when p_horizon = 1 then s.hail_mary_rating else round(ts.target_score)::smallint end as displayed_rating,
      ts.form_rating, ts.fixture_difficulty_rating, ts.fixture_quantity_rating, ts.live_odds_rating,
      gpp.real_total_points,
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
