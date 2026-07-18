-- Flat, frontend-friendly view of the latest projections - avoids the
-- frontend needing to understand the full relational schema (projections
-- -> game_players -> players -> teams -> fantasy_games) or fight
-- PostgREST's nested-embed filtering just to answer "top players for
-- this game". Underlying tables already have public-read RLS policies
-- (migration 0007), so this view inherits readability from those.

create view player_projection_summary as
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
    pr.algorithm_version_id
from projections pr
join game_players gp on gp.id = pr.game_player_id
join players p on p.id = gp.player_id
join teams t on t.id = p.team_id
join fantasy_games fg on fg.id = gp.game_id;
