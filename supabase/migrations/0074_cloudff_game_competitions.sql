-- Cloud FF is EPL-only, same real fixtures/competition FanTeam already
-- uses - without this, team_fixture_difficulty (migration 0017's view,
-- joined through game_competitions rather than game_fixture_gameweeks)
-- has no rows for cloudff at all, and compute_projections.py's
-- resolve_neutral_attack crashes on a real NULL avg(attack_score).
insert into game_competitions (game_id, competition)
select id, 'soccer_epl' from fantasy_games where slug = 'cloudff';
