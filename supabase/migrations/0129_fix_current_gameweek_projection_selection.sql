-- Real bug (2026-08-20 user report): the pool table's "Proj" column and a
-- player's own detail-page "Projected Points" disagreed for the same
-- player at the same time - EFL Fantasy's Matthew Dennis (game_player_id
-- 4966) showed Proj 8.0 in the pool table but 2.0 on his own card.
--
-- Root cause confirmed live: GW2's fixtures span 2026-08-20 to 2026-08-23
-- - its EARLIEST kickoff (19:00 on the 20th) had already passed at query
-- time, while several later GW2 fixtures were still upcoming. The pool
-- table's Proj column is driven by gameweek.ts's planningGameweek (via
-- poolSearch.ts -> search_game_player_pool's p_gameweek param), which
-- advances to the next gameweek the instant a gameweek's *earliest*
-- fixture kicks off - matching real transfer-deadline behaviour, and
-- already GW3 by the time this bug was reported. But these two views'
-- own "current_gw" lateral subquery instead looked for ANY fixture in a
-- gameweek still not kicked off (`f.kickoff_at >= now()`), so it stayed
-- on GW2 as long as even one of its later fixtures hadn't started -
-- drifting a whole gameweek behind gameweek.ts every time a gameweek's
-- fixtures span more than one kickoff moment, which EFL Fantasy's
-- multi-day gameweeks do constantly (and any other game's could too).
--
-- Fix: change current_gw to the same group-min-kickoff-per-gameweek rule
-- gameweek.ts already uses (earliestKickoffByGameweek) - a gameweek only
-- counts as "still upcoming" once its OWN earliest fixture hasn't kicked
-- off yet, via group by + having min(kickoff_at) >= now() instead of a
-- bare per-fixture filter. That's the only change in both views below -
-- every other column/join is byte-identical to migrations 0068
-- (player_projection_summary) and 0128 (game_player_pool).
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
    (pr.inputs->>'points_per_90')::numeric as points_per_90,
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
    where gfg.game_id = gp.game_id
    group by gfg.gameweek
    having min(f.kickoff_at) >= now()
    order by gfg.gameweek asc
    limit 1
) current_gw on true
join lateral (
    select
        pr_1.id,
        pr_1.algorithm_version_id,
        pr_1.game_player_id,
        pr_1.season,
        pr_1.gameweek,
        pr_1.hail_mary_score,
        pr_1.inputs,
        pr_1.created_at,
        pr_1.period_start,
        pr_1.period_end
    from projections pr_1
    where pr_1.game_player_id = gp.id
    order by (not pr_1.gameweek is distinct from current_gw.gameweek) desc, pr_1.created_at desc
    limit 1
) pr on true
where gp.is_active = true;

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
    gp.competition,
    p.id as player_id,
    gp.ownership_pct,
    real_stats.total_points as real_total_points,
    real_stats.appearances as real_appearances,
    real_stats.goals as real_goals,
    real_stats.assists as real_assists,
    real_stats.clean_sheets as real_clean_sheets,
    real_stats.saves as real_saves,
    real_stats.tackles as real_tackles,
    real_stats.clearances as real_clearances,
    real_stats.blocks as real_blocks,
    real_stats.interceptions as real_interceptions,
    real_stats.key_passes as real_key_passes,
    real_stats.shots_on_target as real_shots_on_target,
    last_result.gameweek as last_gw,
    last_result.actual_points as last_gw_points,
    ffscout.status as ffscout_status,
    ffscout.start_probability as ffscout_start_probability,
    rotation.start_probability as rotation_start_probability,
    rotation.contender_name as rotation_contender_name,
    rotation.contender_probability as rotation_contender_probability,
    rotation.risk_level as rotation_risk_level,
    ffscout_detail.detail as ffscout_detail,
    ffscout_detail.expected_return_date as ffscout_expected_return_date,
    real_stats.season as real_season
from game_players gp
join players p on p.id = gp.player_id
join teams t on t.id = p.team_id
join fantasy_games fg on fg.id = gp.game_id
left join lateral (
    select gfg.gameweek
    from game_fixture_gameweeks gfg
    join fixtures f on f.id = gfg.fixture_id
    where gfg.game_id = gp.game_id
    group by gfg.gameweek
    having min(f.kickoff_at) >= now()
    order by gfg.gameweek asc
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
left join lateral (
    select
        gps.total_points,
        gps.season,
        coalesce((gps.raw_stats->>'appearances')::int, 0) as appearances,
        gps.goals, gps.assists, gps.clean_sheets, gps.saves,
        coalesce((gps.raw_stats->>'tackles')::int, 0) as tackles,
        coalesce((gps.raw_stats->>'clearances')::int, 0) as clearances,
        coalesce((gps.raw_stats->>'blocks')::int, 0) as blocks,
        coalesce((gps.raw_stats->>'interceptions')::int, 0) as interceptions,
        coalesce((gps.raw_stats->>'keyPasses')::int, 0) as key_passes,
        coalesce((gps.raw_stats->>'shotsOnTarget')::int, 0) as shots_on_target
    from game_player_stats gps
    where gps.game_player_id = gp.id and gps.gameweek = 0
    order by gps.created_at desc
    limit 1
) real_stats on true
left join lateral (
    select pgp.gameweek, pgp.actual_points
    from player_gameweek_predictions pgp
    where pgp.game_player_id = gp.id and pgp.actual_points is not null
    order by pgp.gameweek desc
    limit 1
) last_result on true
left join lateral (
    select s.status, s.start_probability
    from ffscout_player_status s
    where s.player_id = p.id and s.snapshot_date >= current_date - interval '8 days'
    order by s.snapshot_date desc, s.captured_at desc
    limit 1
) ffscout on true
left join lateral (
    select s.detail, s.expected_return_date
    from ffscout_player_status s
    where s.player_id = p.id and s.snapshot_date >= current_date - interval '8 days'
      and s.detail is not null
    order by s.snapshot_date desc, s.captured_at desc
    limit 1
) ffscout_detail on true
left join lateral (
    select r.start_probability, r.contender_name, r.contender_probability, r.risk_level
    from player_rotation_risk r
    where r.player_id = p.id
      and (select max(l.snapshot_date) from player_lineup_probability_latest l) >= current_date - interval '30 days'
) rotation on true
where gp.is_active;
