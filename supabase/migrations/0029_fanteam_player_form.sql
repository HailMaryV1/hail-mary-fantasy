-- FanTeam's live players feed (playerChoices[] - see scraper_fanteam.py /
-- import_fanteam_live.py) also carries per-player, per-gameweek form/
-- minutes/points fields alongside lineup/status (captured by migration
-- 0027) - confirmed present in the raw feed but not yet captured
-- anywhere. All read 0 right now (pre-season, no matches played -
-- confirmed by direct inspection of fanteam_players_raw.json), exactly
-- like lineup/status did before real variance appeared. Captured now so
-- the Swing Opportunity Score's "current form" factor
-- (frontend/src/lib/swingOpportunity.ts) has real data the moment
-- matches start, with no follow-up migration needed later.

alter table fanteam_player_status add column form numeric;
alter table fanteam_player_status add column minutes int;
alter table fanteam_player_status add column total_points numeric;
alter table fanteam_player_status add column last_points numeric;

-- Extend game_player_pool (same "add a column, create or replace view"
-- pattern migration 0027 used for lineup/status) so every existing
-- select("*") caller gets `form` for free with no frontend query change.
create or replace view game_player_pool as
select
    fg.slug as game_slug,
    gp.id as game_player_id,
    p.full_name,
    p.position,
    t.id as team_id,
    t.name as team_name,
    gp.price,
    latest_proj.hail_mary_score,
    latest_status.lineup,
    latest_status.status,
    latest_status.form
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
left join lateral (
    select lineup, status, form
    from fanteam_player_status s
    where s.game_player_id = gp.id
    order by s.gameweek desc, s.scraped_at desc
    limit 1
) latest_status on true
where gp.is_active;
