-- Exposes pr.inputs (and pr.gameweek, already-selected algorithm_version_id
-- kept) on player_projection_summary - purely additive, same view
-- selection logic already fixed in migration 0062 (current-gameweek
-- preferred, fallback to most recent), just returning more columns from
-- the same already-correct row. This is what lets the Engine
-- Explainability layer (frontend/src/lib/engineExplainability.ts) read
-- module_detail/player_role_detail/data_confidence/module_scenarios
-- (see compute_projections.py) without a second query.
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
    gp.id as game_player_id,
    pr.gameweek,
    pr.inputs
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
