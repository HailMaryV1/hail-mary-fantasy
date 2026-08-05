-- EFL Fantasy (fantasy.efl.com) - the official EFL fantasy game, covering
-- the Championship, League One, and League Two as ONE combined player pool
-- (not three separate games) - confirmed live via fantasy.efl.com's own
-- public, unauthenticated JSON API (/json/fantasy/competitions.json shows
-- exactly 3 rows: Championship id 10, League One id 11, League Two id 12).
-- Deliberately just the fantasy_games row for now, same staged pattern as
-- migration 0072's Cloud FF row - schema for the squad/scoring rules
-- follows in later migrations once the real rules are fully captured.
insert into fantasy_games (slug, display_name) values ('eflfantasy', 'EFL Fantasy');
