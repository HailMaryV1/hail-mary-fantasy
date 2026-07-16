-- Normalized (overround-removed) implied win/draw/loss probability per
-- fixture, computed from the raw bookmaker prices in fixture_odds.
--
-- Bookmaker decimal odds always imply >100% combined probability (their
-- margin/overround) - e.g. 1/1.15 + 1/7.00 + 1/18.00 = 0.996 (before
-- normalizing) is actually under 100% in this specific case, but
-- typically overshoots 100% by several percent. We divide each raw
-- implied probability by the sum of all three so they land on exactly
-- 100%, giving the bookmaker's true underlying assessment without their
-- margin baked in.
--
-- Append-only like fixture_odds (not upserted) - odds move as kickoff
-- approaches, and keeping every computed_at snapshot lets us later ask
-- "how did the algorithm's difficulty assessment change over the week",
-- not just "what's the current value".

create table fixture_probabilities (
  id bigint generated always as identity primary key,
  fixture_id bigint not null references fixtures(id) on delete cascade,
  home_win_prob numeric(5, 4) not null,
  draw_prob numeric(5, 4) not null,
  away_win_prob numeric(5, 4) not null,
  bookmaker_count int not null,
  computed_at timestamptz not null default now()
);

create index on fixture_probabilities (fixture_id, computed_at desc);
