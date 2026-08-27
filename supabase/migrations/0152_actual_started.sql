-- Real per-gameweek "did this player start" flag (2026-08-27 user
-- request - "use players minutes played to see who we expect to start
-- or make appearances... this could replace the solio static crap").
-- Same table Recent Form already reads real per-gameweek results from
-- (actual_minutes/actual_goals/actual_assists, fetch_recent_gameweek_
-- observations in scripts/compute_projections.py) - one more real-
-- result column, populated by the new scripts/import_dreamteamtonic_
-- starts.py from a public third-party API (dreamteamtonic.co.uk) that
-- reports an explicit started-vs-subbed-on flag per player per real
-- gameweek, not inferred from minutes. Nullable: a gameweek this
-- source hasn't been captured for yet (or a player it couldn't match)
-- stays null, never a fabricated false.
alter table player_gameweek_predictions
  add column actual_started boolean;
