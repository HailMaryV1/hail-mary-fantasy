-- Real user request 2026-08-27, after seeing DreamTeamTonic's own "Dream
-- Team GW Points" table (Total Pts / Owned % / Mins columns): "all this
-- should be pulled into our rankings table... we should be able to
-- filter by average minutes played." real_total_points and ownership_pct
-- were already exposed (see migration 0155) - game_player_pool has
-- carried real_minutes_played since migration 0139 too, it just was
-- never selected here. No new data source needed for this one - it's
-- real for all 4 games already (FanTeam/Cloud FF/EFL Fantasy from their
-- own live per-gameweek imports, Dream Team newly real as of today's
-- DreamTeamTonic-sourced fix, scripts/import_dreamteamtonic_starts.py's
-- accumulate_dreamteam_current_season_row).
--
-- A true per-game AVERAGE needs a real "games played" denominator that
-- doesn't exist consistently across all 4 games' own real_stats yet
-- (Dream Team's own raw_stats->>'games_played_derived' has one, the
-- other 3 games' game_player_pool view doesn't expose an equivalent) -
-- exposing the real total minutes-played figure directly for now (still
-- answers "is this player actually getting game time", the real
-- question behind the request) rather than fabricating an average from
-- a denominator this view doesn't reliably have everywhere. Revisit once
-- every game has a real games-played count wired into game_player_pool.
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
    p_min_minutes numeric default null,
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
    real_total_points numeric, real_minutes_played numeric,
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
      gpp.real_total_points, gpp.real_minutes_played,
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
      and (p_min_minutes is null or gpp.real_minutes_played >= p_min_minutes)
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
      when 'minutes' then real_minutes_played
      else coalesce(displayed_rating, 0)::numeric
    end desc nulls last,
    full_name asc
  limit p_limit offset p_offset;
$$;
