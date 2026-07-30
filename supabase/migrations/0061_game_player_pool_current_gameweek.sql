-- game_player_pool used to pick each player's score by
-- `ORDER BY pr.created_at DESC LIMIT 1` with no gameweek filter at all -
-- meaning it showed whichever gameweek's projection had most recently
-- been (re)computed, NOT the current actionable gameweek. refresh_all.py
-- recomputes every upcoming gameweek (up to 5) in ascending order on
-- every run, so the LAST one computed - currently GW5 - always won,
-- silently showing a later (and often tougher) fixture's number in
-- place of GW1's real projection across Rankings, Team Builder,
-- Transfers, Watchlist and My Team. Confirmed live: Gabriel Magalhaes'
-- real GW1 projection is 5.36 (favourable fixture) but the view was
-- showing 5.02 (his GW5 number, a harder fixture) as "his score."
--
-- Fixed to prefer the projection for the game's own current actionable
-- gameweek (same "next gameweek with an unstarted fixture" definition
-- every other current-gameweek lookup in this app already uses), falling
-- back to the old "most recent by created_at" behaviour only when no
-- projection exists yet for that exact gameweek (e.g. a game with no
-- published calendar, or a player not yet scored for the coming week) -
-- so this never regresses to a blank score, only ever fixes which
-- gameweek's real number gets shown.

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
    latest_status.lineup,
    latest_status.status,
    latest_status.form
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
    where s.game_player_id = gp.id
    order by s.gameweek desc, s.scraped_at desc
    limit 1
) latest_status on true
where gp.is_active;
