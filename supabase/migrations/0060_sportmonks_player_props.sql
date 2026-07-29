-- SportMonks reintroduction (see memory reference_hail_mary_infra.md -
-- dropped once before for fixture/match-odds, since The Odds API alone
-- covered that). This time it's specifically for PLAYER-level bookmaker
-- markets (e.g. anytime goalscorer) that The Odds API's own player-prop
-- markets have never actually populated for us in practice - a
-- different use case, not a duplicate of what was already dropped.

-- A fixture now carries two independent external references - Odds
-- API's `external_id` (already existed) and SportMonks' own fixture id,
-- used purely to look up that fixture's player-market odds. Nullable:
-- most fixtures won't be linked until import_sportmonks_player_props.py
-- has run its linking pass against them.
alter table fixtures add column sportmonks_fixture_id bigint unique;

-- Most recent REAL (bookmaker-sourced) player-prop probability per
-- player+market, plus the team_fixture_difficulty.attack_score that
-- applied to the fixture it was observed under. This is the anchor a
-- future fixture with no real prop odds posted yet gets scaled against
-- (see frontend/src/lib/estimatedPlayerProps.ts) - never fabricated
-- from nothing, only ever written alongside a genuine
-- fixture_player_props insert for a name-matched player. `unique
-- (player_id, market)` deliberately keeps only the single latest real
-- observation per player+market, since that's the only anchor the
-- scaling estimate ever needs.
create table player_prop_baselines (
  id bigint generated always as identity primary key,
  player_id bigint not null references players(id) on delete cascade,
  market text not null,
  fixture_id bigint not null references fixtures(id),
  observed_probability numeric(5, 4) not null,
  team_attack_score numeric(6, 4) not null,
  observed_at timestamptz not null default now(),
  unique (player_id, market)
);

create index on player_prop_baselines (player_id);

alter table player_prop_baselines enable row level security;
create policy "public read" on player_prop_baselines for select using (true);
