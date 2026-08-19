-- Live team-news signal from fantasyfootballscout.co.uk/team-news (real,
-- public, unauthenticated Premier League page - Out/Doubts-with-%/Banned
-- per club), 2026-08-19 user request to close the "zero live signal at
-- all" gap for Dream Team and Cloud FF (fetch_live_status() in
-- compute_projections.py has always hard-returned {} for them - FanTeam
-- and EFL Fantasy are the only games with their own live-status feed).
--
-- Keyed by player_id (nullable) + team_id, NOT duplicated per-game - this
-- is objective third-party real-world fact (same shared identity as
-- players itself), not a platform-specific feed like fanteam_player_status.
-- player_id is nullable for the same reason player_lineup_probability's is
-- (migration 0110): short/abbreviated names won't all resolve cleanly on
-- the first pass, and a wrong auto-match is worse than an unmatched row
-- sitting visibly unresolved - raw_name is always kept so a later re-match
-- never loses information.
--
-- start_probability is only meaningful for status='doubt' (FFScout's own
-- modelled percentage chance of starting - 75% doubt feeds
-- expected_minutes_fraction as roughly x0.75, not filtered through a
-- coarse discrete bucket - see compute_opportunity()'s
-- FFSCOUT_DOUBT_BLEND_WEIGHT). 'out'/'banned' rows have start_probability
-- null - they map straight to p_start=0 via OPPORTUNITY_HARD_OUT_STATUSES.
create table ffscout_player_status (
    id bigint generated always as identity primary key,
    player_id bigint references players(id),
    team_id bigint not null references teams(id),
    raw_name text not null,
    status text not null check (status in ('out', 'doubt', 'banned')),
    start_probability numeric check (start_probability is null or (start_probability >= 0 and start_probability <= 100)),
    snapshot_date date not null,
    source text not null default 'ffscout',
    captured_at timestamptz not null default now(),
    unique (team_id, raw_name, snapshot_date, source)
);

create index ffscout_player_status_player_id_idx on ffscout_player_status(player_id);

-- "most recent row per player within a staleness window" is the real read
-- pattern (compute_projections.py's fetch_ffscout_player_status) - this
-- covers it without a global max(snapshot_date), so one club's parse
-- failure on one run only affects that club's players, not everyone's.
create index ffscout_player_status_player_recency_idx on ffscout_player_status(player_id, snapshot_date desc, captured_at desc);
