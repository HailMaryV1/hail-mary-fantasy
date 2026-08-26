-- Real user report 2026-08-26 (screenshot of Kjell Scherpen's Fantasy
-- Stats panel, labelled "Real 2025/26 season results, not a projection"):
-- "why is scherpen only showing as player 75 minutes? strange".
--
-- Root cause: `real_minutes_played` (and every other counting stat below
-- it) reads from `real_stats` (game_player_stats gameweek=0) for EVERY
-- game - but that row is only genuinely real, live season-to-date data
-- for EFL Fantasy (its own import_eflfantasy.py keeps it fresh every
-- run - confirmed live, its gameweek=0 rows carry the real 2026/27
-- season label and update daily). For the other 3 games it's something
-- else entirely:
--   - Dream Team/Cloud FF: migration 0139 already caught and fixed this
--     EXACT bug class for real_total_points - that row is deliberately
--     repurposed by seed_dreamteam_historical_stats.py/seed_cloudff_
--     historical_stats.py as the scoring engine's own shrinkage-prior
--     slot, recomputed fresh on every compute_projections.py run (which
--     is why it looked "live" - Scherpen's 75 minutes was actually
--     today's recomputed PRIOR, not his real 2025/26 minutes). 0139
--     only fixed the total_points column; every other real_* column
--     was left reading the same repurposed prior.
--   - FanTeam: confirmed live - every gameweek=0 row for this game
--     carries the IDENTICAL created_at (2026-07-16), a one-time stale
--     snapshot nothing has ever refreshed since (no FanTeam-specific
--     writer targets game_player_stats at all) - the exact same
--     staleness bug migration 0138 already fixed for real_total_points,
--     just never extended to these columns either.
--
-- Fix, following 0139's own precedent exactly:
--   - real_minutes_played: Dream Team/Cloud FF now sum real per-
--     gameweek captured minutes from player_gameweek_results (the same
--     genuine capture pipeline 0139 already wired total_points to -
--     self-heals to a real number once a gameweek actually finishes,
--     honestly null until then). FanTeam now reads fanteam_player_
--     status.minutes - a real live field already captured every scrape
--     cycle (import_fanteam_live.py), just never wired to this column.
--   - Every OTHER counting stat (goals/assists/clean_sheets/saves/
--     tackles/clearances/blocks/interceptions/key_passes/shots_on_
--     target) has no genuine per-gameweek OR live capture source at all
--     for Dream Team/Cloud FF/FanTeam - not "hard to find", genuinely
--     doesn't exist anywhere in this schema. Rather than keep showing a
--     stale/synthetic number under a "Real... not a projection" label,
--     these now go honestly null for those 3 games - same "never fake a
--     number" rule this whole feature already lives by. EFL Fantasy's
--     real, live values are completely unaffected.
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
        when fg.slug in ('dreamteam', 'cloudff') then real_actuals.total_minutes::integer
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
