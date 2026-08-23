-- Same class of bug as migration 0138 (FanTeam), found while checking
-- the other 3 games per user request 2026-08-23: Dream Team and Cloud
-- FF's "Total Pts" has always come from real_stats (game_player_stats
-- gameweek=0) - but for these two games that row is NOT real season-
-- to-date points at all. seed_dreamteam_historical_stats.py/seed_
-- cloudff_historical_stats.py deliberately repurpose it as a SCORING-
-- MODEL shrinkage-prior slot (see that file's own docstring: "written
-- to season=HISTORICAL_SEASON... repurposed... as 'the shrinkage-prior
-- slot', not literally last calendar year"), recomputed under this
-- project's own approximate formula - a legitimate input for
-- compute_projections.py, never meant to be shown to a user as "how
-- many real points has this player scored".
--
-- Both games DO have a genuine real per-gameweek capture pipeline
-- (capture_dreamteam_actuals/capture_cloudff_actuals in capture_
-- gameweek_actuals.py, writing to player_gameweek_results) - confirmed
-- live 2026-08-23 it correctly returns nothing yet ("No completed
-- Dream Team/Cloud FF gameweeks yet - skipping"), since GW1 has a
-- fixture still to be played for both. That's the RIGHT real answer,
-- not a bug - "Total Pts" for these two games should honestly show
-- nothing until it exists, never the repurposed prior. Self-heals once
-- GW1 actually finishes and the automated actuals capture runs.
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
    real_stats.minutes_played as real_minutes_played,
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
    select s.lineup, s.status, s.form, s.total_points
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
    select sum(pgr.actual_points) as total_points
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
