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

-- Squad-building rules, confirmed with the user (FanTeam budget is their
-- own best estimate, not verified against FanTeam's rules page - a config
-- value, trivial to correct later).

insert into game_squad_rules (game_id, squad_size, starting_size, budget, max_per_club, uses_formations, gk_quota, def_quota, mid_quota, fwd_quota)
select id, 11, 11, 50.00, null, true, null, null, null, null
from fantasy_games where slug = 'dreamteam'
on conflict (game_id) do nothing;

insert into game_squad_rules (game_id, squad_size, starting_size, budget, max_per_club, uses_formations, gk_quota, def_quota, mid_quota, fwd_quota)
select id, 15, 11, 100.00, 3, false, 2, 5, 5, 3
from fantasy_games where slug = 'fanteam'
on conflict (game_id) do nothing;

insert into game_formations (game_id, code, gk_count, def_count, mid_count, fwd_count)
select fg.id, f.code, f.gk, f.def, f.mid, f.fwd
from fantasy_games fg, (values
    ('4-4-2', 1, 4, 4, 2),
    ('4-3-3', 1, 4, 3, 3),
    ('4-5-1', 1, 4, 5, 1),
    ('3-4-3', 1, 3, 4, 3),
    ('3-5-2', 1, 3, 5, 2),
    ('5-4-1', 1, 5, 4, 1),
    ('5-3-2', 1, 5, 3, 2)
) as f(code, gk, def, mid, fwd)
where fg.slug = 'dreamteam'
on conflict (game_id, code) do nothing;
