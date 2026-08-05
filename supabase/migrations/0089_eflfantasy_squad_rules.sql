-- EFL Fantasy's real squad shape, confirmed live via fantasy.efl.com's
-- team-builder UI: exactly 9 picks, no bench - 1 GK, 2 DEF, 2 MID, 2 FWD,
-- plus 2 CLUB picks (see migration 0087's docstring). Formation is fixed
-- (shown as "2-2-2" on the real site, not user-selectable), so
-- uses_formations = false with explicit quota columns, same shape Dream
-- Team/Cloud FF already use for their own fixed/quota squads.
--
-- No budget at all - confirmed live: fantasy.efl.com's own
-- /json/fantasy/players.json has no price/value field on any of its 3,386
-- real players, and the real UI never shows a budget figure. Every other
-- game's game_squad_rules.budget is NOT NULL, so this is a real gap -
-- rather than faking a budget that doesn't exist, budget is made nullable
-- and left null for this game only. frontend-v2's gameConfig.ts gates the
-- Bank/Value stat tiles and Value Bands filters off a new `hasBudget` flag
-- keyed on this being null, so the UI doesn't show a fake £0.00 budget.
alter table game_squad_rules alter column budget drop not null;

-- club_quota is new - no existing game has a "pick N whole clubs" slot
-- type, so there's no existing column for it alongside gk/def/mid/fwd_quota.
alter table game_squad_rules add column club_quota int;

insert into game_squad_rules (game_id, squad_size, starting_size, budget, max_per_club, uses_formations, gk_quota, def_quota, mid_quota, fwd_quota, club_quota)
select fg.id, 9, 9, null, null, false, 1, 2, 2, 2, 2
from fantasy_games fg
where fg.slug = 'eflfantasy'
on conflict (game_id) do nothing;
