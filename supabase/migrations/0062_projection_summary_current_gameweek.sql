-- Same bug as 0061 (game_player_pool), found in the two other places
-- that pick "the latest projection" for a player: player_projection_summary
-- (Rankings, Player Detail, Compare, Watchlist Transfer-In) and
-- player_projection_fixtures (the fixture-by-fixture "why this score"
-- breakdown on Player Detail). Both plainly did
-- `ORDER BY created_at DESC LIMIT 1` with no gameweek filter, so once
-- refresh_all.py started recomputing multiple upcoming gameweeks per
-- run, both silently showed whichever gameweek happened to be computed
-- last (currently GW5) instead of the current actionable one (GW1).
-- Same fix pattern: prefer the projection for the game's own current
-- gameweek, fall back to the old "most recent" behaviour only when none
-- exists for that exact gameweek yet.

create or replace view player_projection_summary as
select
    fg.slug as game_slug,
    p.full_name,
    p.position,
    t.name as team_name,
    gp.price,
    pr.hail_mary_score,
    pr.period_start,
    pr.period_end,
    (pr.inputs ->> 'points_per_90')::numeric as points_per_90,
    pr.algorithm_version_id,
    gp.id as game_player_id
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
join lateral (
    select pr_1.id, pr_1.algorithm_version_id, pr_1.game_player_id, pr_1.season, pr_1.gameweek,
           pr_1.hail_mary_score, pr_1.inputs, pr_1.created_at, pr_1.period_start, pr_1.period_end
    from projections pr_1
    where pr_1.game_player_id = gp.id
    order by (pr_1.gameweek is not distinct from current_gw.gameweek) desc, pr_1.created_at desc
    limit 1
) pr on true;

create or replace view player_projection_fixtures as
with latest_projection as (
    select distinct on (pr.game_player_id)
        pr.id, pr.algorithm_version_id, pr.game_player_id, pr.season, pr.gameweek,
        pr.hail_mary_score, pr.inputs, pr.created_at, pr.period_start, pr.period_end
    from projections pr
    join game_players gp on gp.id = pr.game_player_id
    left join lateral (
        select gfg.gameweek
        from game_fixture_gameweeks gfg
        join fixtures f on f.id = gfg.fixture_id
        where gfg.game_id = gp.game_id and f.kickoff_at >= now()
        order by gfg.gameweek asc, f.kickoff_at asc
        limit 1
    ) current_gw on true
    order by pr.game_player_id, (pr.gameweek is not distinct from current_gw.gameweek) desc, pr.created_at desc
)
select
    pr.id as projection_id,
    pr.game_player_id,
    (fx.value ->> 'fixture_id')::bigint as fixture_id,
    f.kickoff_at,
    case when f.home_team_id = p.team_id then away_t.name else home_t.name end as opponent,
    (f.home_team_id = p.team_id) as is_home,
    (fx.value ->> 'attack_score')::numeric as attack_score,
    (fx.value ->> 'clean_sheet_score')::numeric as clean_sheet_score,
    (fx.value ->> 'fixture_factor')::numeric as fixture_factor,
    (fx.value ->> 'contribution')::numeric as contribution
from latest_projection pr
cross join lateral jsonb_array_elements(pr.inputs -> 'fixtures') fx(value)
join game_players gp on gp.id = pr.game_player_id
join players p on p.id = gp.player_id
join fixtures f on f.id = (fx.value ->> 'fixture_id')::bigint
join teams home_t on home_t.id = f.home_team_id
join teams away_t on away_t.id = f.away_team_id;
