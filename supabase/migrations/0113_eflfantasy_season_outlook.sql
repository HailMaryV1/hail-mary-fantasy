-- EFL Fantasy season-outlook signal (2026-08-09 user request): before a
-- ball is kicked, there is no real season-long form/results data for
-- Championship/League One/League Two clubs at all - the only meaningful
-- proxy for "how good is this club going to be this season" is the
-- bookmakers' own promotion/relegation markets, which the user has
-- supplied directly (top-5 favourites for both promotion and relegation,
-- each league). This is the EFL Fantasy analogue of the pre-season
-- lineup-probability rotation-risk signal (migration 0111) - a stand-in
-- for real data that doesn't exist yet, meant to switch off once it does
-- (see eflSeasonOutlook.ts's fetch function, gated on seasonStarted the
-- same way fetchRotationRiskByPlayerIds is).
--
-- Deliberately scoped to EFL Fantasy only - this data has zero connection
-- to the Premier League games (dreamteam/fanteam/cloudff), the inverse of
-- feedback_data_source_scope_correlation's lesson but the same principle:
-- a data source only gets wired into the game(s) it actually covers.
create table team_season_outlook (
    id bigint generated always as identity primary key,
    team_id bigint not null references teams(id),
    competition text not null check (competition in ('efl_championship', 'efl_league_one', 'efl_league_two')),
    outlook text not null check (outlook in ('promotion', 'relegation')),
    rank int not null,
    odds_fraction text not null,
    implied_probability numeric not null check (implied_probability > 0 and implied_probability <= 1),
    season text not null,
    source text not null default 'bookmaker_odds_manual',
    created_at timestamptz not null default now(),
    unique (team_id, competition, outlook, season)
);

create index team_season_outlook_team_id_idx on team_season_outlook (team_id);
