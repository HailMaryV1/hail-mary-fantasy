-- Parallel provenance quads for booking_probability and
-- expected_shots_on_target, exactly mirroring migration 0069's
-- assist_is_estimated/assist_source/assist_confidence/
-- assist_market_observed_at pattern - these two markets are now real,
-- independently-observed-or-missing signals on bookmaker_player_features
-- (see scripts/import_sportmonks_player_props.py), so each needs its own
-- provenance columns rather than sharing the goal market's is_estimated/
-- source/confidence/market_observed_at (which would make one market's
-- write silently stomp on another's provenance flag for the same row).
--
-- sending_off_probability is deliberately NOT given a provenance quad
-- here - live-probed against real, near-kickoff fixtures (Arsenal v
-- Coventry, Cardiff v Wrexham) and no per-player "sent off" market was
-- observed on either (only a match-level "Red Card in the Match" yes/no,
-- which isn't player-attributable) - so there is nothing real to write
-- into that column yet. Left for a future pass if SportMonks ever prices
-- it for one of our entitled leagues.

alter table bookmaker_player_features
  add column booking_is_estimated boolean,
  add column booking_source text,
  add column booking_confidence numeric,
  add column booking_market_observed_at timestamptz,
  add column shots_on_target_is_estimated boolean,
  add column shots_on_target_source text,
  add column shots_on_target_confidence numeric,
  add column shots_on_target_market_observed_at timestamptz;
