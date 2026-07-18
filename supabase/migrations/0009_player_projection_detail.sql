-- Enables the player detail page: "why is this player's score what it
-- is" - the algorithm's reasoning needs to be inspectable, not just its
-- output, since the whole point of this season is auditing predictions
-- against outcomes and tuning the algorithm from what's wrong.
--
-- player_projection_summary gains game_player_id so the frontend can
-- link a rankings row to its detail page.
-- player_projection_fixtures unpacks the per-fixture breakdown already
-- stored in projections.inputs (jsonb) and joins back to fixtures/teams
-- to resolve the opponent name and home/away - that data exists today
-- because compute_projections.py already stores it per fixture, this
-- view just makes it queryable directly instead of parsing jsonb client-side.

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
from projections pr
join game_players gp on gp.id = pr.game_player_id
join players p on p.id = gp.player_id
join teams t on t.id = p.team_id
join fantasy_games fg on fg.id = gp.game_id;

create view player_projection_fixtures as
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
from projections pr
cross join lateral jsonb_array_elements(pr.inputs -> 'fixtures') as fx(value)
join game_players gp on gp.id = pr.game_player_id
join players p on p.id = gp.player_id
join fixtures f on f.id = (fx.value ->> 'fixture_id')::bigint
join teams home_t on home_t.id = f.home_team_id
join teams away_t on away_t.id = f.away_team_id;
