-- EFL Fantasy's own live availability table - deliberately NOT
-- fanteam_player_status. That table is FanTeam's own live-lineup feed
-- (import_fanteam_live.py owns it); EFL Fantasy has a completely
-- different real source (fantasy.efl.com/json/fantasy/players.json's
-- own "status" field: playing/injured/suspended/eliminated, plus real
-- injuryDetails/suspensionDetails text) and per this app's per-game
-- independent identity rule, every game gets its own status structure,
-- never a shared one. "eliminated" is already handled at the
-- game_players.is_active level (see import_eflfantasy.py, 2026-08-08) -
-- this table is for the in-season injured/suspended signal that used to
-- go uncaptured entirely, confirmed live 2026-08-08 (Jack Tucker showing
-- "injured" on the real site while still being recommended/pickable
-- here).
--
-- No "lineup" column - EFL Fantasy's feed has no predicted-lineup
-- concept (no confirmed_starting/expected/might_start granularity like
-- FanTeam's), only this coarser availability status. compute_projections.py's
-- compute_opportunity() already treats a bare `status` value of
-- "injured"/"suspended" as a hard out (OPPORTUNITY_HARD_OUT_STATUSES) -
-- no lineup blend needed for this game.
create table eflfantasy_player_status (
    id bigserial primary key,
    game_player_id bigint not null references game_players(id) on delete cascade,
    gameweek integer not null,
    status text,
    injury_detail text,
    suspension_detail text,
    scraped_at timestamptz not null default now(),
    unique (game_player_id, gameweek)
);

create index eflfantasy_player_status_game_player_id_idx on eflfantasy_player_status(game_player_id);
