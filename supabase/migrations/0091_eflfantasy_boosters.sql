-- EFL Fantasy's 2 boosters, confirmed live via /json/fantasy/loco/en.json's
-- "booster.modal" copy: "Max Captain" (available TWICE per season - the
-- highest-scoring player in your team automatically becomes captain,
-- retroactively, for that gameweek) and "One Club" (available ONCE per
-- season - pick up to 7 players from one club, for one gameweek only).
--
-- `active_booster` already exists (migration 0084, Dream Team's boosters)
-- and is a shared free-text column on `squads` - each squad row belongs to
-- exactly one game via game_id, so reusing the literal string 'max_captain'
-- here doesn't collide with Dream Team's own same-named booster (different
-- rows, same vocabulary, same pattern this repo already accepts of
-- per-game columns sitting unused on other games' rows - see 0084's own
-- docstring). Just widening the CHECK to also allow 'one_club'.
--
-- The USED-gameweek tracking columns can't be reused, though: Dream Team's
-- existing `max_captain_used_gameweek int` is single-use (Dream Team's own
-- Max Captain is once/season), but EFL Fantasy's version is twice/season -
-- needs two columns, following FanTeam's own wildcard_1/wildcard_2 pattern
-- (migration 0022) rather than Dream Team's single-column one.
alter table squads drop constraint squads_active_booster_check;
alter table squads add constraint squads_active_booster_check
  check (active_booster in ('goal_bonus', 'twelfth_man', 'max_captain', 'one_club'));

alter table squads add column efl_max_captain_used_gameweek_1 int;
alter table squads add column efl_max_captain_used_gameweek_2 int;
alter table squads add column efl_one_club_used_gameweek int;
