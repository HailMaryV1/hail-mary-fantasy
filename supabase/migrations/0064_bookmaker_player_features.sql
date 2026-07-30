-- The central Bookmaker Intelligence Hub's player-level table - neutral,
-- game-independent probabilities/expected values for one (player,
-- fixture), NOT FanTeam- or Dream Team-specific projected points. Every
-- fantasy game's scoring engine reads the SAME row and prices it through
-- its own game_scoring_rules; no game ever re-derives or duplicates this
-- computation. Deliberately has no game_id column - a real-world fixture
-- has exactly one bookmaker-implied probability per player, regardless
-- of which fantasy game happens to be scoring it.
--
-- Populated by scripts/import_sportmonks_player_props.py: a REAL row
-- (is_estimated = false) whenever SportMonks has actually posted the
-- relevant market for this exact fixture; otherwise an ESTIMATED row
-- (is_estimated = true) scaled from the player's last real observation
-- by how this fixture's team strength compares to the one it was
-- observed under (same technique frontend/src/lib/
-- estimatedPlayerProps.ts already implements for Ask Mary - now
-- centralized here so every consumer reads one resolved value instead
-- of each re-deriving the fallback independently). A column with no
-- data source ingested yet (expected_shots, booking/sending-off
-- probability - Tier 2 markets, not yet built) simply stays null - never
-- fabricated - until that market's ingestion lands.
create table bookmaker_player_features (
  id bigint generated always as identity primary key,
  player_id bigint not null references players(id) on delete cascade,
  fixture_id bigint not null references fixtures(id) on delete cascade,

  score_probability numeric(5, 4),            -- P(scores >= 1 goal)
  assist_probability numeric(5, 4),           -- P(assists >= 1)
  score_or_assist_probability numeric(5, 4),  -- P(scores or assists) - not simply the sum, see ingestion
  expected_shots numeric(5, 2),
  expected_shots_on_target numeric(5, 2),
  booking_probability numeric(5, 4),
  sending_off_probability numeric(5, 4),

  is_estimated boolean not null,              -- false = a real bookmaker market observed for this exact fixture
  source text not null,                       -- e.g. 'sportmonks_real' | 'sportmonks_baseline_scaled'
  confidence numeric(3, 2) not null default 1.0,  -- 1.0 for a fresh real observation, lower for a scaled estimate
  market_observed_at timestamptz,             -- when the underlying real odds were actually seen (not just computed_at)
  computed_at timestamptz not null default now(),

  unique (player_id, fixture_id)
);

create index on bookmaker_player_features (fixture_id);

alter table bookmaker_player_features enable row level security;
create policy "public read" on bookmaker_player_features for select using (true);
