-- Splits the single manual_strength_override (migration 0151) into
-- separate home/away overrides, matching Dream Team Tonic's own "Edit
-- Team Strengths" tool (2026-08-27 user request - "lets copy something
-- similar... their tool has separate Home and Away strength sliders").
-- A team's real strength genuinely differs by venue - the automated
-- fallback (home_strength/away_strength, migration 0102) already models
-- this for EFL Fantasy's own real per-venue FDR; the manual override
-- should be able to express the same thing, not force one flat number
-- onto both sides.
alter table team_season_strength
  add column manual_home_strength_override numeric(6, 4)
    check (manual_home_strength_override is null or manual_home_strength_override between -1 and 1),
  add column manual_away_strength_override numeric(6, 4)
    check (manual_away_strength_override is null or manual_away_strength_override between -1 and 1);

-- Preserve any live override (confirmed: Aston Villa was set to 2.5 as
-- a real, deliberate adjustment via the admin page, not test data) by
-- carrying the old flat value onto both new columns - the closest
-- equivalent to what a single symmetric override already represented.
update team_season_strength
  set manual_home_strength_override = manual_strength_override,
      manual_away_strength_override = manual_strength_override
  where manual_strength_override is not null;

alter table team_season_strength drop column manual_strength_override;
