-- Real user report 2026-08-26: "When you click - next 2 or next 3
-- gameweeks. it should show the next fixtures that occur during those
-- gameweeks selected" - the row list only ever showed ONE fixture (the
-- nearest, from projections.inputs.fixtures[0]) no matter which horizon
-- was selected. target_scores.inputs.window_fixtures already stores the
-- real per-team fixture list for the exact window each row was scored
-- over (built by compute_target_scores.py's fetch_window_fixture_rows)
-- - this just surfaces it, same jsonb passthrough pattern already used
-- elsewhere in this RPC rather than re-deriving it from fixtures/
-- game_fixture_gameweeks a second time.
--
-- Also adds last_gw/last_gw_points (from game_player_pool, already
-- real) - powers the new "Live Gameweek" info tab (2026-08-26 user
-- request: "what mary predicted the best players where and whats
-- actually happening") which needs to show a real actual result
-- alongside the prediction, not just the prediction.
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
    hail_mary_rating smallint, target_score numeric,
    form_rating smallint, fixture_difficulty_rating smallint,
    fixture_quantity_rating smallint, live_odds_rating smallint,
    end_gameweek int,
    opponent_team_name text, fixture_is_home boolean, fixture_kickoff_at timestamptz,
    window_fixtures jsonb,
    last_gw int, last_gw_points numeric
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
  ranked as (
    select
      gpp.position,
      row_number() over (
        partition by gpp.position
        order by
          case when p_horizon = 1 then s.hail_mary_rating end desc nulls last,
          case when p_horizon > 1 then ts.target_score end desc nulls last,
          s.hail_mary_score desc nulls last
      ) as rnk,
      gpp.game_player_id, gpp.full_name, gpp.team_id, gpp.team_name,
      s.hail_mary_rating,
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
    hail_mary_rating, target_score, form_rating, fixture_difficulty_rating,
    fixture_quantity_rating, live_odds_rating, end_gameweek,
    opponent_team_name, fixture_is_home, fixture_kickoff_at,
    window_fixtures, last_gw, last_gw_points
  from ranked
  where rnk <= p_limit
  order by position, rnk;
$$;
