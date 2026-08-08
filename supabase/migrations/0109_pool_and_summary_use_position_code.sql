-- Fixes a real cross-game data bug (2026-08-08 user report): different
-- real platforms genuinely classify some players in different positions
-- (e.g. Matheus Cunha is MID on Dream Team's own feed, FWD on FanTeam's)
-- but both game_player_pool and player_projection_summary were reading
-- the single shared `players.position` column, which gets unconditionally
-- overwritten by whichever game's importer last ran - so one game would
-- silently display the wrong position whenever a genuine disagreement
-- existed. `game_players.position_code` already stores each game's own
-- classification (and is now canonicalized to GK/DEF/MID/FWD for every
-- football game as of the same date - see import_dreamteam.py/
-- import_fanteam_live.py's matching 2026-08-08 fix and the one-time
-- backfill applied directly). Swapping both views to read it fixes the
-- display bug and everything downstream (scoring buckets, transfer
-- eligibility, squad-quota checks) without needing a new join - gp/p are
-- already both in scope in each view.
create or replace view game_player_pool as
select
    fg.slug as game_slug,
    gp.id as game_player_id,
    p.full_name,
    gp.position_code as position,
    t.id as team_id,
    t.name as team_name,
    gp.price,
    coalesce(proj_for_current_gw.hail_mary_score, proj_fallback.hail_mary_score) as hail_mary_score,
    fanteam_status.lineup,
    coalesce(fanteam_status.status, eflfantasy_status.status) as status,
    fanteam_status.form,
    gp.competition
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
left join lateral (
    select pr.hail_mary_score
    from projections pr
    where pr.game_player_id = gp.id
      and pr.gameweek is not distinct from current_gw.gameweek
    order by pr.created_at desc
    limit 1
) proj_for_current_gw on true
left join lateral (
    select pr.hail_mary_score
    from projections pr
    where pr.game_player_id = gp.id
    order by pr.created_at desc
    limit 1
) proj_fallback on true
left join lateral (
    select s.lineup, s.status, s.form
    from fanteam_player_status s
    where s.game_player_id = gp.id and fg.slug = 'fanteam'
    order by s.gameweek desc, s.scraped_at desc
    limit 1
) fanteam_status on true
left join lateral (
    select s.status
    from eflfantasy_player_status s
    where s.game_player_id = gp.id and fg.slug = 'eflfantasy'
    order by s.gameweek desc, s.scraped_at desc
    limit 1
) eflfantasy_status on true
where gp.is_active;

create or replace view player_projection_summary as
select
    fg.slug as game_slug,
    p.full_name,
    gp.position_code as position,
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
