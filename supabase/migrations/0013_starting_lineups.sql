-- Starting XI selection - a separate, weekly-ish action from squad
-- building (migration 0011). Only matters for games with a bench
-- (squad_size > starting_size, i.e. FanTeam: 15-man squad, 11 start).
-- Dream Team's squad_size == starting_size (11 == 11, no bench), so the
-- squad itself already IS the starting XI - no lineup step needed there.
--
-- Reuses game_formations rather than inventing a new table: a formation
-- is just "1 GK + a DEF/MID/FWD split summing to 11" regardless of
-- whether it's constraining your whole squad (Dream Team) or your
-- starting XI within a bigger squad (FanTeam) - same shape, different
-- application-level meaning.

alter table squads add column starting_formation_id bigint references game_formations(id);
alter table squad_players add column is_starting boolean not null default true;

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
where fg.slug = 'fanteam'
on conflict (game_id, code) do nothing;
