-- Splits the pool view's single fanteam_player_status join (migration
-- 0061, unchanged since) into one lateral per game's OWN status table -
-- it was unconditionally joining fanteam_player_status for every game's
-- rows, including EFL Fantasy's, which happened to return nothing
-- (EFL Fantasy game_player_ids never appear in that table) but was
-- architecturally wrong: two different games' rows should never be
-- capable of querying the same live-status source. Each lateral below
-- is scoped by fg.slug so it only ever matches rows that belong to it -
-- eflfantasy_player_status (migration 0104) is EFL Fantasy's own table,
-- fully independent of FanTeam's.
--
-- No "form" from EFL Fantasy's status table (it doesn't capture one,
-- unlike FanTeam's) - coalesces to fanteam's only, same as before this
-- migration for every non-fanteam game.
create or replace view game_player_pool as
select
    fg.slug as game_slug,
    gp.id as game_player_id,
    p.full_name,
    p.position,
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
