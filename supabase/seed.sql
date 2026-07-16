-- Reference data (not schema) - which Odds API competitions count toward
-- which fantasy game. Safe to re-run (ON CONFLICT DO NOTHING).
--
-- FanTeam: confirmed Premier League only.
-- Dream Team: confirmed European competitions count. FA Cup / EFL Cup
-- inclusion is an assumption (Dream Team is a general football game so
-- likely includes domestic cups too) - worth confirming and editing this
-- table directly if wrong, no migration needed.

insert into game_competitions (game_id, competition)
select id, competition
from fantasy_games, unnest(array[
    'soccer_epl',
    'soccer_uefa_champs_league',
    'soccer_uefa_champs_league_qualification',
    'soccer_uefa_europa_league',
    'soccer_uefa_europa_conference_league',
    'soccer_fa_cup',
    'soccer_england_efl_cup'
]) as competition
where slug = 'dreamteam'
on conflict do nothing;

insert into game_competitions (game_id, competition)
select id, 'soccer_epl'
from fantasy_games
where slug = 'fanteam'
on conflict do nothing;
