-- NFL FanTeam - the third game, alongside Dream Team and FanTeam
-- (Premier League). Deliberately just the fantasy_games row for now -
-- game_squad_rules/game_formations/game_scoring_rules and the NFL
-- player/team data model come in a later stage once the historical data
-- source (FanTeam's own last-season NFL dashboard) has actually been
-- reviewed. Adding this row now lets the new gateway dashboard show NFL
-- FanTeam as a real, distinct "coming soon" destination rather than a
-- hardcoded placeholder that isn't backed by the same fantasy_games
-- table every other game already uses.

insert into fantasy_games (slug, display_name) values ('nfl-fanteam', 'NFL FanTeam');
