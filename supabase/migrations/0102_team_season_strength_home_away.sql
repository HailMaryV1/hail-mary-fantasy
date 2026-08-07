-- Adds optional home/away-context strength ratings alongside the
-- existing single `strength` column, so a source that genuinely rates a
-- team differently at home vs away (EFL Fantasy's own real fdrHome/
-- fdrAway - see import_eflfantasy.py's seed_team_strength) can express
-- that, instead of being forced into one flat number applied
-- identically regardless of venue.
--
-- Nullable, backward-compatible: every existing writer (compute_team_
-- strength.py, for the real-bookmaker-odds games) only ever sets
-- `strength` and leaves these two null - compute_fixture_strength_
-- probabilities.py falls back to `strength` for either side whenever
-- its context-specific column is null, so this is zero-drift for every
-- game except EFL Fantasy, which is the whole point of this change.
alter table team_season_strength
  add column home_strength numeric(6, 4),
  add column away_strength numeric(6, 4);
