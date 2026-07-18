-- Captain/vice-captain selection. Both must be among the squad's
-- starting XI (squad_players.is_starting = true) - a benched player
-- can't be captain. For Dream Team, every squad_player defaults to
-- is_starting = true (no bench, see migration 0013), so this naturally
-- covers the whole squad there without any special-casing.

alter table squads add column captain_game_player_id bigint references game_players(id);
alter table squads add column vice_captain_game_player_id bigint references game_players(id);
