-- Real user request 2026-08-26: "maybe we should build our own
-- adjustable fixture difficulty scale... for when form alters
-- throughout the season". Premier League's `team_season_strength.
-- strength` is seeded ONCE per season from manually-transcribed top-5/
-- relegation odds (scripts/compute_team_strength.py) and never
-- automatically updated as form actually changes - this adds a real,
-- web-editable override column, additive to (never overwriting) that
-- automated baseline, so compute_team_strength.py can keep re-seeding
-- it without clobbering a live manual adjustment.
--
-- A manual-override mechanism for exactly this already existed as a
-- hardcoded Python dict (scripts/set_manual_pl_fixture_strength.py,
-- writing home_strength/away_strength) - this is the same idea as a
-- real, single-number column instead, matching the user's own choice
-- of "one overall strength number per team" over a home/away split.
-- compute_fixture_strength_probabilities.py already reads this table
-- with no other logic change needed - see that script's own docstring.
alter table team_season_strength
  add column manual_strength_override numeric(6, 4)
    check (manual_strength_override is null or manual_strength_override between -1 and 1),
  add column manual_strength_updated_at timestamptz;
