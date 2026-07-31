-- Cloud Fantasy Football (cloud-ff.co.uk) - real auth/squad-read API
-- confirmed live 2026-07-31 (login + getUserTeam return real, direct
-- numeric PlayerIDs - no name-matching needed for squad sync at all,
-- unlike FanTeam's DOM-only squad page). Deliberately just the
-- fantasy_games row for now, same pattern as migration 0037's NFL
-- FanTeam row - game_scoring_rules and the players/game_players import
-- come in a later stage once the real scoring formula has been reviewed
-- (Cloud FF's own getPlayerStats already returns pre-computed per-stat
-- point breakdowns, worth reusing rather than reverse-engineering from
-- scratch).

insert into fantasy_games (slug, display_name) values ('cloudff', 'Cloud Fantasy Football');
