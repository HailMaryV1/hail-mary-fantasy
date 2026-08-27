-- Real user request 2026-08-27 - after shipping real per-gameweek
-- minutes for Dream Team from DreamTeamTonic (scripts/import_
-- dreamteamtonic_starts.py's accumulate_dreamteam_current_season_row),
-- the new "Mins" column (migration 0156) still showed "-" for every
-- Dream Team player. Root cause: migration 0145 deliberately routes
-- Dream Team/Cloud FF's real_minutes_played through real_actuals
-- (player_gameweek_results, populated by capture_dreamteam_actuals only
-- once a real gameweek is detected as complete) rather than game_
-- player_stats - correct caution AT THE TIME, since that gameweek=0 slot
-- held the scoring engine's own repurposed shrinkage-prior, never real
-- minutes, for Dream Team. Today's fix makes that no longer true FOR
-- DREAM TEAM SPECIFICALLY: game_player_stats now has a genuine real row
-- there (season = '2026/27', minutes_played summed from DreamTeamTonic's
-- real per-gameweek data) alongside the still-repurposed '2025/26' row.
--
-- Adds a season-scoped lateral join (unlike real_stats above, which
-- picks "whichever gameweek=0 row was created most recently" - both the
-- real 2026/27 row and the repurposed 2025/26 prior get touched on
-- every refresh cycle, so that ordering alone can't tell them apart) and
-- prefers it for Dream Team's real_minutes_played, falling back to
-- real_actuals (unchanged behaviour) if it's ever empty. Cloud FF is
-- NOT changed here - its own game_player_stats CURRENT_SEASON row isn't
-- backed by a real per-gameweek source the way Dream Team's now is (see
-- import_dreamteamtonic_starts.py's own documented caveat on Cloud FF's
-- fix), so real_actuals stays its only source, same as before.
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
    coalesce(
        fanteam_status.total_points,
        case when fg.slug in ('dreamteam', 'cloudff') then real_actuals.total_points else real_stats.total_points end
    )::numeric(6,2) as real_total_points,
    case
        when fg.slug = 'dreamteam' then coalesce(real_stats_current.minutes_played, real_actuals.total_minutes::integer)
        when fg.slug = 'cloudff' then real_actuals.total_minutes::integer
        when fg.slug = 'fanteam' then fanteam_status.minutes
        else real_stats.minutes_played
    end as real_minutes_played,
    case when fg.slug = 'eflfantasy' then real_stats.goals end as real_goals,
    case when fg.slug = 'eflfantasy' then real_stats.assists end as real_assists,
    case when fg.slug = 'eflfantasy' then real_stats.clean_sheets end as real_clean_sheets,
    case when fg.slug = 'eflfantasy' then real_stats.saves end as real_saves,
    case when fg.slug = 'eflfantasy' then real_stats.tackles end as real_tackles,
    case when fg.slug = 'eflfantasy' then real_stats.clearances end as real_clearances,
    case when fg.slug = 'eflfantasy' then real_stats.blocks end as real_blocks,
    case when fg.slug = 'eflfantasy' then real_stats.interceptions end as real_interceptions,
    case when fg.slug = 'eflfantasy' then real_stats.key_passes end as real_key_passes,
    case when fg.slug = 'eflfantasy' then real_stats.shots_on_target end as real_shots_on_target,
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
    real_stats.season as real_season,
    coalesce(proj_for_current_gw.hail_mary_rating, proj_fallback.hail_mary_rating) as hail_mary_rating
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
    select pr.hail_mary_score, pr.hail_mary_rating
    from projections pr
    where pr.game_player_id = gp.id
      and pr.gameweek is not distinct from current_gw.gameweek
    order by pr.created_at desc
    limit 1
) proj_for_current_gw on true
left join lateral (
    select pr.hail_mary_score, pr.hail_mary_rating
    from projections pr
    where pr.game_player_id = gp.id
    order by pr.created_at desc
    limit 1
) proj_fallback on true
left join lateral (
    select s.lineup, s.status, s.form, s.total_points, s.minutes
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
        gps.total_points, gps.season, gps.minutes_played, gps.goals, gps.assists,
        gps.clean_sheets, gps.saves,
        coalesce((gps.raw_stats->>'tackles')::integer, 0) as tackles,
        coalesce((gps.raw_stats->>'clearances')::integer, 0) as clearances,
        coalesce((gps.raw_stats->>'blocks')::integer, 0) as blocks,
        coalesce((gps.raw_stats->>'interceptions')::integer, 0) as interceptions,
        coalesce((gps.raw_stats->>'keyPasses')::integer, 0) as key_passes,
        coalesce((gps.raw_stats->>'shotsOnTarget')::integer, 0) as shots_on_target
    from game_player_stats gps
    where gps.game_player_id = gp.id and gps.gameweek = 0
    order by gps.created_at desc
    limit 1
) real_stats on true
left join lateral (
    select gps.minutes_played
    from game_player_stats gps
    where gps.game_player_id = gp.id and gps.gameweek = 0 and gps.season = '2026/27' and fg.slug = 'dreamteam'
    limit 1
) real_stats_current on true
left join lateral (
    select sum(pgr.actual_points) as total_points, sum(pgr.actual_minutes) as total_minutes
    from player_gameweek_results pgr
    where pgr.game_player_id = gp.id and fg.slug in ('dreamteam', 'cloudff')
) real_actuals on true
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
    where s.player_id = p.id and s.snapshot_date >= current_date - interval '8 days' and s.detail is not null
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
