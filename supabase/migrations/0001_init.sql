-- Hail Mary Fantasy Sports - core schema
-- Canonical players/teams, per-game mappings, per-game stats, algorithm versioning.
--
-- Design notes:
--   - "players" and "teams" are the canonical, game-agnostic identity layer.
--   - Each fantasy game (Dream Team, FanTeam, ...) has its own external ID,
--     position code, and price for a player - that lives in game_players.
--   - Only ~7 stat fields are common across every game we've seen so far
--     (minutes, goals, assists, clean sheets, saves, goals conceded, cards).
--     Everything else a game tracks (bonus points, IMPACT, appearance-tier
--     points, defensive actions, etc.) goes in raw_stats as jsonb, so a new
--     game or a new stat a game starts tracking never requires a migration.
--   - algorithm_versions + projections let every Hail Mary Score be traced
--     back to the exact weighting/version that produced it, so predictions
--     can be backtested against outcomes version by version.

create table teams (
  id bigint generated always as identity primary key,
  name text not null unique,          -- canonical name, e.g. "Manchester City"
  short_name text,                    -- e.g. "Man City"
  created_at timestamptz not null default now()
);

-- Different sources spell/abbreviate team names differently
-- (Dream Team: "Man City", FanTeam: "Manchester City"). This maps
-- each source's spelling back to the canonical team.
create table team_aliases (
  id bigint generated always as identity primary key,
  team_id bigint not null references teams(id) on delete cascade,
  source text not null,               -- 'dreamteam' | 'fanteam'
  external_name text not null,
  unique (source, external_name)
);

create table players (
  id bigint generated always as identity primary key,
  full_name text not null,            -- canonical name, e.g. "Erling Haaland"
  team_id bigint references teams(id),
  position text not null check (position in ('GK', 'DEF', 'MID', 'FWD')),
  created_at timestamptz not null default now()
);

create table fantasy_games (
  id bigint generated always as identity primary key,
  slug text not null unique,          -- 'dreamteam' | 'fanteam'
  display_name text not null
);

-- One row per (game, player): that game's own ID, price and position code
-- for a canonical player. This is what "price" and squad-building hang off.
create table game_players (
  id bigint generated always as identity primary key,
  game_id bigint not null references fantasy_games(id) on delete cascade,
  player_id bigint not null references players(id) on delete cascade,
  external_id text not null,          -- that game's own playerId
  position_code text not null,        -- that game's own position string, e.g. 'STR' vs 'FOR'
  price numeric(5, 2) not null,
  is_active boolean not null default true,
  updated_at timestamptz not null default now(),
  unique (game_id, external_id)
);

create table game_player_stats (
  id bigint generated always as identity primary key,
  game_player_id bigint not null references game_players(id) on delete cascade,
  season text not null,               -- e.g. '2025/26'
  gameweek int,                       -- null = season-total snapshot
  minutes_played int not null default 0,
  goals int not null default 0,
  assists int not null default 0,
  clean_sheets int not null default 0,
  saves int not null default 0,
  goals_conceded int not null default 0,
  yellow_cards int not null default 0,
  red_cards int not null default 0,
  total_points numeric(6, 2) not null default 0,
  raw_stats jsonb not null default '{}',
  created_at timestamptz not null default now(),
  unique (game_player_id, season, gameweek)
);

create table algorithm_versions (
  id bigint generated always as identity primary key,
  version_label text not null unique,  -- e.g. 'v1', 'v2-form-weighted'
  description text,
  weights jsonb not null default '{}',
  created_at timestamptz not null default now()
);

create table projections (
  id bigint generated always as identity primary key,
  algorithm_version_id bigint not null references algorithm_versions(id),
  game_player_id bigint not null references game_players(id) on delete cascade,
  season text not null,
  gameweek int not null,
  hail_mary_score numeric(6, 2) not null,
  inputs jsonb not null default '{}',  -- inputs that produced this score, for auditability
  created_at timestamptz not null default now(),
  unique (algorithm_version_id, game_player_id, gameweek)
);

create index on game_player_stats (game_player_id);
create index on projections (game_player_id, gameweek);
create index on game_players (player_id);
create index on game_players (game_id);
