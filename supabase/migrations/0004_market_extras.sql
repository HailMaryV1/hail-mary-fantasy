-- Richer fixture-quality signals, sketched in ahead of having real data
-- to populate them with: bookmakers only post team-specific goal lines
-- and player prop markets close to matchday (confirmed empirically -
-- empty for a fixture 5 weeks out, even though the market keys are
-- valid on our plan). These tables exist now so the ingestion code has
-- somewhere to land data once it starts appearing, rather than this
-- design getting forgotten and rediscovered later.

-- Team-specific goal totals (e.g. "Arsenal Team Total Over/Under 1.5") -
-- the real clean-sheet market, much better than approximating clean
-- sheet probability from win/draw odds once this is populated.
create table fixture_team_totals (
  id bigint generated always as identity primary key,
  fixture_id bigint not null references fixtures(id) on delete cascade,
  team_id bigint not null references teams(id),
  bookmaker text not null,
  line numeric(4, 2) not null,
  over_price numeric(6, 2) not null,
  under_price numeric(6, 2) not null,
  fetched_at timestamptz not null default now()
);

-- Player-specific prop markets (anytime goalscorer, shots on target,
-- assists). player_name_raw is kept as plain text rather than linked to
-- players.id for now - we haven't seen a single real Odds API player
-- name yet (nothing posted this far from kickoff), so building a
-- name-matching approach now would be guessing rather than validating,
-- the same trap avoided with the Dream Team/FanTeam player matching.
-- player_id gets filled in once that matching is built against real data.
create table fixture_player_props (
  id bigint generated always as identity primary key,
  fixture_id bigint not null references fixtures(id) on delete cascade,
  player_name_raw text not null,
  player_id bigint references players(id),
  market text not null,              -- e.g. 'player_goal_scorer_anytime'
  bookmaker text not null,
  price numeric(6, 2) not null,
  line numeric(4, 2),                -- null for anytime markets, set for shots/assists O-U
  fetched_at timestamptz not null default now()
);

create index on fixture_team_totals (fixture_id, team_id);
create index on fixture_player_props (fixture_id);
create index on fixture_player_props (player_id);
