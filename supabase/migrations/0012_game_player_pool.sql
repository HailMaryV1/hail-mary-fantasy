-- Full player pool per game, for the squad builder - deliberately
-- different from player_projection_summary (migration 0008/0009), which
-- inner-joins to projections and would silently hide any player without
-- a computed score (zero minutes last season, backup keepers, etc.) from
-- the picker. Here hail_mary_score is an optional enrichment (left join,
-- latest projection), never a filter on who's selectable.

create view game_player_pool as
select
    fg.slug as game_slug,
    gp.id as game_player_id,
    p.full_name,
    p.position,
    t.id as team_id,
    t.name as team_name,
    gp.price,
    latest_proj.hail_mary_score
from game_players gp
join players p on p.id = gp.player_id
join teams t on t.id = p.team_id
join fantasy_games fg on fg.id = gp.game_id
left join lateral (
    select hail_mary_score
    from projections pr
    where pr.game_player_id = gp.id
    order by pr.created_at desc
    limit 1
) latest_proj on true
where gp.is_active;
