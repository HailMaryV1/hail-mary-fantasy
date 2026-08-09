-- New external signal (2026-08-08 user request): weekly "projected lineup"
-- graphics from a third-party analyst (Solio Analytics / @FPL_Spaceman),
-- manually screenshotted by the user and transcribed here - not an API,
-- there's nothing to scrape. Each graphic gives, per formation slot, every
-- realistic candidate and their real modelled start probability (not just
-- "who's nailed" - the gap between the top two candidates in a slot is
-- itself the rotation-risk signal).
--
-- Deliberately NOT wired into compute_projections.py yet - this is the
-- landing table only, same phased-rollout discipline as every other
-- external signal in this project (Bookmaker Intelligence, Fantasy
-- Influence): land the data, validate it against real gameweeks, then
-- decide how (and at what weight) it feeds scoring/eligibility.
--
-- player_id is nullable - short/abbreviated names on the graphic ("B.
-- Fernandes", "E.Le Fée") won't all resolve cleanly against a same-surname
-- teammate on the first pass, and a wrong auto-match here is worse than an
-- unmatched row sitting visibly unresolved. raw_name is always kept so a
-- later re-match never loses information.
create table player_lineup_probability (
    id bigint generated always as identity primary key,
    team_id bigint not null references teams(id),
    formation text not null,
    position_slot text not null,
    slot_rank int not null,
    player_id bigint references players(id),
    raw_name text not null,
    start_probability numeric not null check (start_probability >= 0 and start_probability <= 100),
    is_new_signing boolean not null default false,
    snapshot_date date not null,
    source text not null default 'solio_analytics_fpl_spaceman',
    created_at timestamptz not null default now(),
    unique (team_id, position_slot, slot_rank, snapshot_date, source)
);

create index player_lineup_probability_player_id_idx on player_lineup_probability(player_id);
create index player_lineup_probability_team_snapshot_idx on player_lineup_probability(team_id, snapshot_date);
