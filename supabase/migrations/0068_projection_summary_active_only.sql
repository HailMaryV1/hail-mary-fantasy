-- player_projection_summary has never filtered on game_players.is_active
-- across its whole history (0008 -> 0018 -> 0062 -> 0066) - it just joins
-- whichever game_player rows happen to have at least one projections row.
-- Surfaced concretely by scripts/merge_reclassified_player_duplicates.py:
-- the 4 now-deactivated phantom identities (Ampadu/Guessand/Bogarde/
-- Wieffer duplicates) still had old projections rows from past compute
-- runs, so they kept appearing in the Engine Validation player search
-- (frontend/src/lib/engineExplainability.ts's fetchPlayerOptions/
-- fetchEngineExplanation both read this view) even after being
-- deactivated - a real gap for ANY inactive game_player with a stray old
-- projection, not just these 4. Ask Mary and the optimiser were never
-- affected (they read game_player_pool, which already filters
-- is_active) - this is purely about what search/explainability surfaces.
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
) pr on true
where gp.is_active = true;
