-- Real user request 2026-08-18: alert on large swings in bookmaker
-- player-prop odds - a sudden shortening/lengthening can reflect
-- insider knowledge about a lineup before it's public (e.g. a
-- teammate's anytime-scorer price shortening a lot right after a star
-- striker is quietly ruled out).
--
-- bookmaker_player_features (migration 0064 + 0069 + 0117) is UPSERTed
-- on conflict (player_id, fixture_id) - every refresh (twice daily,
-- refresh_shared_odds.yml) overwrites score_probability/assist_probability/
-- booking_probability/expected_shots_on_target in place, so there is no
-- way to compare "this refresh vs last refresh" from that table alone.
-- This is a plain append-only log, one row per REAL market observation
-- (never for an estimated/scaled row - see import_sportmonks_player_props.py's
-- populate_hub() comment on why is_estimated=true rows are a different,
-- less interesting signal: a fixture's own win-probability moving, not a
-- specific player's role/fitness), written alongside (not instead of)
-- the existing hub upsert. scripts/detect_odds_swings.py reads the two
-- most recent rows per (player_id, fixture_id, market) to compute a
-- delta - same "insert now, compare later" pattern fixture_odds already
-- uses successfully (see import_fixtures_odds.py's insert_odds).
create table bookmaker_player_probability_history (
  id bigint generated always as identity primary key,
  player_id bigint not null references players(id) on delete cascade,
  fixture_id bigint not null references fixtures(id) on delete cascade,
  market text not null check (market in ('goal', 'assist', 'booking', 'shot_on_target')),
  -- goal/assist/booking store a real probability (0-1); shot_on_target
  -- stores an expected COUNT (see populate_hub()'s Poisson conversion) -
  -- same "whatever unit the hub column itself uses" convention, so a
  -- delta computed on this value always means the same thing the hub's
  -- own column means for that market.
  value numeric not null,
  observed_at timestamptz not null default now(),
  -- Set once scripts/detect_odds_swings.py has sent a push for a swing
  -- landing on this exact row - stops the same swing re-alerting every
  -- 12-hour cycle for as long as the new value persists.
  alerted boolean not null default false
);

create index idx_bookmaker_player_probability_history_lookup
  on bookmaker_player_probability_history (player_id, fixture_id, market, observed_at desc);
