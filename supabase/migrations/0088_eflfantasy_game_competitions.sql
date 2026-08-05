-- Every other game's game_competitions.competition value is an Odds API
-- sport_key (e.g. 'soccer_epl') because their fixtures/odds come from Odds
-- API. EFL Fantasy's fixtures/results come directly from fantasy.efl.com's
-- own /json/fantasy/rounds.json instead (confirmed live - real, public,
-- unauthenticated) - Odds API's coverage of Championship/League One/League
-- Two is unconfirmed and not needed for the core build. These 3 values are
-- therefore synthetic, scoped only to this game, and deliberately don't
-- collide with any real Odds API sport_key.
insert into game_competitions (game_id, competition)
select fg.id, v.competition
from fantasy_games fg
cross join (values ('efl_championship'), ('efl_league_one'), ('efl_league_two')) as v(competition)
where fg.slug = 'eflfantasy'
on conflict (game_id, competition) do nothing;
