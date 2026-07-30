-- bookmaker_player_features (migration 0064) has a single is_estimated/
-- source/confidence/market_observed_at set describing "the" bookmaker
-- signal on a row - fine while only score_probability (goal) was ever
-- populated, but now that assist_probability gets its own independent
-- real/estimated ingestion path (scripts/import_sportmonks_player_props.py,
-- "Player to Assist" market), a single shared is_estimated flag can no
-- longer represent "goal is a real observation, assist is only an
-- estimate for this same row" (or vice versa) - whichever market's
-- import ran most recently would silently overwrite the other stat's
-- provenance. Found while wiring the assist pathway, not speculative.
--
-- Fix: assist gets its own parallel provenance columns, mirroring the
-- original ones exactly. The original (unprefixed) columns are left
-- exactly as they are - in practice they have only ever described the
-- goal/score_probability signal - renaming them would touch every
-- existing reader (fetch_hub_features, bookmaker_data_source,
-- populate_estimated_hub_rows) for no behavioural benefit.
alter table bookmaker_player_features
  add column assist_is_estimated boolean,
  add column assist_source text,
  add column assist_confidence numeric(3, 2),
  add column assist_market_observed_at timestamptz;
