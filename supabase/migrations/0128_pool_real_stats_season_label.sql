-- Real bug (2026-08-20 user report): the "Fantasy Stats" panel on the
-- player info card always says "Real results this season" even when the
-- real_stats lateral join (migration 0121) fell back to last season's
-- row - e.g. Michael Kayode's 196 total pts / 11 clean sheets is his real
-- 2025/26 season, captured pre-season on 2026-07-16; there is no 2026/27
-- row for him yet. Confirmed live: game_player_stats.season is a real
-- text column ("2025/26") that was simply never surfaced.
--
-- Fix is additive only: expose the literal season string the row actually
-- came from, appended as the new LAST column so this stays a valid
-- CREATE OR REPLACE VIEW. The frontend then labels the panel with that
-- literal season ("Real 2025/26 season results") instead of always
-- claiming "this season" - correct today, and correct again once a real
-- 2026/27 row exists, with no season-comparison logic needed on either
-- side (same "most recent by created_at, no hardcoded season constant"
-- design migration 0121 already established for this join).
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

-- search_game_player_pool is untouched here - it lists its own explicit
-- column set from game_player_pool rather than `select *`, so a new
-- trailing view column has zero effect on it. The player-info-card real
-- stats panel (this fix's actual target) reads game_player_pool directly
-- via playerExplanationActions.ts's getPlayerRealStatsAction, not this RPC.
