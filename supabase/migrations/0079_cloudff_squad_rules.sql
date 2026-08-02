-- Cloud FF frontend wiring, step 1 of N - seeds the real, live-verified
-- Cloud FF rules the user provided directly (not guessed): 11-player
-- squad, no separate bench, £100m budget, no per-club limit, one of 6
-- named formations. This exact shape (squad_size = starting_size,
-- uses_formations = true, all quota columns null) is the same one
-- Dream Team already uses successfully - not a new pattern.
--
-- Verified against the real synced squad (id 23) before writing this:
-- 1 GK / 4 DEF / 4 MID / 2 FWD, £99.90m total - fits the 4-4-2 row below
-- exactly, under the £100m budget below.
insert into game_squad_rules (game_id, squad_size, starting_size, budget, max_per_club, uses_formations)
select fg.id, 11, 11, 100.00, null, true
from fantasy_games fg
where fg.slug = 'cloudff'
on conflict (game_id) do nothing;

insert into game_formations (game_id, code, gk_count, def_count, mid_count, fwd_count)
select fg.id, v.code, 1, v.def_count, v.mid_count, v.fwd_count
from fantasy_games fg
cross join (
  values
    ('4-3-3', 4, 3, 3),
    ('4-4-2', 4, 4, 2),
    ('4-5-1', 4, 5, 1),
    ('3-5-2', 3, 5, 2),
    ('5-3-2', 5, 3, 2),
    ('3-4-3', 3, 4, 3)
) as v(code, def_count, mid_count, fwd_count)
where fg.slug = 'cloudff'
on conflict (game_id, code) do nothing;
