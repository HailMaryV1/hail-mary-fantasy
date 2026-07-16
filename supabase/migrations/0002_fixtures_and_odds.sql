-- Fixtures + odds, sourced entirely from The Odds API (single provider,
-- so fixtures and odds share the same team-name spelling - no second
-- cross-source alias set needed, unlike the Dream Team/FanTeam case).
--
-- Design notes:
--   - "competition" is the Odds API's own sport_key (e.g. 'soccer_epl',
--     'soccer_uefa_champs_league'). Using their key directly (rather than
--     inventing our own enum) avoids a translation layer that could drift.
--   - game_competitions says which competitions count toward which
--     fantasy game's scoring/fixture-quantity - e.g. Dream Team counts
--     European competitions, FanTeam is Premier League only.
--   - fixture_odds keeps one row per bookmaker per fixture (raw truth),
--     rather than pre-averaging - the algorithm decides how to combine
--     bookmakers later, and averaging is easy to redo but hard to undo.

-- team_aliases.source is a free-text column (no CHECK constraint), so
-- 'oddsapi' just works as a third value alongside 'dreamteam'/'fanteam' -
-- no migration needed for that part.

create table fixtures (
  id bigint generated always as identity primary key,
  external_id text not null unique,        -- Odds API event id
  competition text not null,               -- Odds API sport_key, e.g. 'soccer_epl'
  season text not null,
  home_team_id bigint not null references teams(id),
  away_team_id bigint not null references teams(id),
  kickoff_at timestamptz not null,
  created_at timestamptz not null default now()
);

create table fixture_odds (
  id bigint generated always as identity primary key,
  fixture_id bigint not null references fixtures(id) on delete cascade,
  bookmaker text not null,                 -- Odds API bookmaker key, e.g. 'betfair_sb_uk'
  home_price numeric(6, 2) not null,       -- decimal odds
  draw_price numeric(6, 2) not null,
  away_price numeric(6, 2) not null,
  fetched_at timestamptz not null default now(),
  unique (fixture_id, bookmaker, fetched_at)
);

-- Which competitions count for which fantasy game.
create table game_competitions (
  game_id bigint not null references fantasy_games(id) on delete cascade,
  competition text not null,               -- Odds API sport_key
  primary key (game_id, competition)
);

create index on fixtures (competition, kickoff_at);
create index on fixture_odds (fixture_id);
