-- Historical per-player foul record, the input the /fouls tool has been
-- missing (2026-08-24 user request: "build the per-player foul model from the
-- historical data").
--
-- Until now that tool could only find the bookmaker's internal inconsistencies
-- - it had no opinion of its own about how many fouls a player commits. It
-- turns out SportMonks carries exactly that: statistic type 56 (Fouls) and 96
-- (Fouls Drawn) alongside minutes and appearances, aggregated per player per
-- season, retrievable one call per team-season via /squads/seasons/{s}/teams/{t}.
-- Two finished seasons are available for the Premier League (2024/25, 2025/26)
-- plus the current one.
--
-- KEYED ON SPORTMONKS IDS, ON PURPOSE, with no foreign key to our own players
-- or teams tables. The fouls tool is a betting-market tool with its own route
-- tree and its own engine, sharing no scoring model with the fantasy games
-- (the per-game-independent-identity convention). Joining it to the fantasy
-- player identities would mean name-matching two feeds that already disagree
-- about diacritics, and a bad match here would silently attribute one player's
-- foul record to another. The SportMonks player id is stable and arrives on
-- the same lineup rows the tool already reads, so there is nothing to match.
--
-- One row per player per season per team: a mid-season transfer legitimately
-- produces two rows, and both are real - the unique constraint includes team
-- rather than collapsing them.
create table player_foul_stats (
    id bigint generated always as identity primary key,
    sportmonks_player_id bigint not null,
    sportmonks_team_id bigint not null,
    season_id bigint not null,
    league_id bigint not null,
    season_name text,
    player_name text not null,
    -- SportMonks position type: 24 GK, 25 DEF, 26 MID, 27 FWD. Nullable
    -- because the squad row occasionally omits it, and a wrong positional
    -- prior is worse than falling back to the all-player baseline.
    position_id smallint,
    minutes int not null default 0,
    appearances int not null default 0,
    lineups int not null default 0,
    fouls int not null default 0,
    fouls_drawn int not null default 0,
    captured_at timestamptz not null default now(),
    unique (sportmonks_player_id, season_id, sportmonks_team_id)
);

create index player_foul_stats_player_idx on player_foul_stats(sportmonks_player_id);
create index player_foul_stats_season_team_idx on player_foul_stats(season_id, sportmonks_team_id);
-- The model reads whole seasons at a time to build its positional baselines
-- and league averages, so it filters on league before anything else.
create index player_foul_stats_league_season_idx on player_foul_stats(league_id, season_id);
