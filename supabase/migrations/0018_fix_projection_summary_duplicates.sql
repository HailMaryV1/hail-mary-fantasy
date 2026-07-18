-- player_projection_summary was a plain join to projections, so once a
-- player had more than one projection row (the original period-based
-- run, then gameweek 1, then gameweek 5 - all still in the table), the
-- rankings page and player detail page showed the SAME player multiple
-- times with different scores. game_player_pool already avoided this
-- (it picks the latest projection via a lateral subquery) - this
-- applies the same "latest only" fix here. Caught via a real React key
-- warning in the browser, not assumed correct from the query looking
-- reasonable.

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
join lateral (
    select *
    from projections pr
    where pr.game_player_id = gp.id
    order by pr.created_at desc
    limit 1
) pr on true;

-- Same "latest projection only" fix for the player detail page's
-- fixture-breakdown view - it had the identical bug.
create or replace view player_projection_fixtures as
with latest_projection as (
    select distinct on (game_player_id) *
    from projections
    order by game_player_id, created_at desc
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
cross join lateral jsonb_array_elements(pr.inputs -> 'fixtures') as fx(value)
join game_players gp on gp.id = pr.game_player_id
join players p on p.id = gp.player_id
join fixtures f on f.id = (fx.value ->> 'fixture_id')::bigint
join teams home_t on home_t.id = f.home_team_id
join teams away_t on away_t.id = f.away_team_id;
