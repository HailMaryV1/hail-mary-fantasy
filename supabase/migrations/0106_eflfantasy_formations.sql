-- Corrects a real factual error in migration 0089's own docstring: it
-- claimed "formation is fixed (shown as '2-2-2' on the real site, not
-- user-selectable)" - confirmed WRONG live 2026-08-08 via a screenshot
-- of fantasy.efl.com's own team-builder UI, which shows a real Formation
-- dropdown offering 2-2-2 / 2-3-1 / 3-2-1 for the 6 non-GK outfield
-- slots (GK is always exactly 1 regardless of formation - only the DEF/
-- MID/FWD split changes). club_quota (always 2, no formation involvement -
-- CLUB picks are a separate pool entirely, see migration 0089) is
-- untouched.
--
-- Same pattern already proven for Cloud FF (migration 0079): uses_
-- formations = true, quota columns null (game_formations supplies the
-- real per-formation counts instead), budget stays null (EFL Fantasy's
-- real no-budget rule, migration 0089 - the first formation-based game
-- combined with no budget, but nothing about uses_formations depends on
-- budget being non-null).
update game_squad_rules gsr
set uses_formations = true, gk_quota = null, def_quota = null, mid_quota = null, fwd_quota = null
from fantasy_games fg
where gsr.game_id = fg.id and fg.slug = 'eflfantasy';

insert into game_formations (game_id, code, gk_count, def_count, mid_count, fwd_count)
select fg.id, v.code, 1, v.def_count, v.mid_count, v.fwd_count
from fantasy_games fg
cross join (
  values
    ('2-2-2', 2, 2, 2),
    ('2-3-1', 2, 3, 1),
    ('3-2-1', 3, 2, 1)
) as v(code, def_count, mid_count, fwd_count)
where fg.slug = 'eflfantasy'
on conflict (game_id, code) do nothing;
