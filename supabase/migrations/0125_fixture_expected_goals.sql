-- Real expected-goals-per-team, derived from real bookmaker 1X2 (win/
-- draw/loss) odds - 2026-08-20 user request for an EFL-only "Market
-- Odds" page (Championship/League One/League Two, explicitly NOT
-- Premier League). fixture_team_totals (real bookmaker team-goals
-- lines) exists but is currently near-empty in practice (checked live:
-- every upcoming EFL fixture has line IS NULL) - not usable as a primary
-- source yet. attack_score (team_fixture_difficulty) is a WIN-probability
-- proxy, not a goals count, and using it as a stand-in for "goals" would
-- make the Top 5 Winners and Top 5 Goals grids the user explicitly asked
-- for identical rankings - not what was asked.
--
-- Instead: scripts/compute_expected_goals.py solves for each team's
-- Poisson goal-rate (lambda) that best reproduces the REAL market's own
-- home/draw/away win probabilities under an independent-Poisson scoreline
-- model - a standard, well-documented odds-to-xG technique, not a
-- fabricated number. Real market data in, a real (if modelled) number
-- out - same "estimate clearly derived from real data, not guessed"
-- spirit as every other calibrated blend/prior already documented
-- throughout this project (e.g. compute_projections.py's position-
-- average shrinkage priors).
create table fixture_expected_goals (
    id bigint generated always as identity primary key,
    fixture_id bigint not null references fixtures(id),
    team_id bigint not null references teams(id),
    expected_goals numeric not null check (expected_goals >= 0),
    computed_at timestamptz not null default now(),
    unique (fixture_id, team_id)
);
create index on fixture_expected_goals(fixture_id);

-- Extends team_fixture_difficulty (a pure view, no separate writer
-- script - see its own definition) with expected_goals alongside the
-- existing attack_score/clean_sheet_score, same latest-row-per-fixture
-- pattern as the clean-sheet join it already does.
create or replace view team_fixture_difficulty as
with latest_real_prob as (
    select distinct on (fixture_id) fixture_id, home_win_prob, draw_prob, away_win_prob
    from fixture_probabilities
    order by fixture_id, computed_at desc
), latest_strength_prob as (
    select distinct on (fixture_id) fixture_id, home_win_prob, draw_prob, away_win_prob
    from fixture_strength_model_probabilities
    order by fixture_id, computed_at desc
), fixtures_with_data as (
    select fixture_id from latest_real_prob
    union
    select fixture_id from latest_strength_prob
), latest_prob as (
    select
        fwd.fixture_id,
        coalesce(lr.home_win_prob, ls.home_win_prob) as home_win_prob,
        coalesce(lr.draw_prob, ls.draw_prob) as draw_prob,
        coalesce(lr.away_win_prob, ls.away_win_prob) as away_win_prob,
        case when lr.fixture_id is not null then 'real_odds' else 'fdr' end as source
    from fixtures_with_data fwd
    left join latest_real_prob lr on lr.fixture_id = fwd.fixture_id
    left join latest_strength_prob ls on ls.fixture_id = fwd.fixture_id
), latest_clean_sheet as (
    select distinct on (fixture_id, team_id) fixture_id, team_id, clean_sheet_prob
    from fixture_clean_sheet_probabilities
    order by fixture_id, team_id, computed_at desc
)
select
    gc.game_id, f.id as fixture_id, f.competition, f.kickoff_at, f.home_team_id as team_id,
    lp.home_win_prob as team_win_prob, lp.draw_prob, lp.away_win_prob as opponent_win_prob,
    lp.home_win_prob as attack_score,
    coalesce(lcs.clean_sheet_prob, lp.home_win_prob + 0.5 * lp.draw_prob) as clean_sheet_score,
    lp.source,
    feg.expected_goals
from fixtures f
join game_competitions gc on gc.competition = f.competition
join latest_prob lp on lp.fixture_id = f.id
left join latest_clean_sheet lcs on lcs.fixture_id = f.id and lcs.team_id = f.home_team_id
left join fixture_expected_goals feg on feg.fixture_id = f.id and feg.team_id = f.home_team_id
union all
select
    gc.game_id, f.id as fixture_id, f.competition, f.kickoff_at, f.away_team_id as team_id,
    lp.away_win_prob as team_win_prob, lp.draw_prob, lp.home_win_prob as opponent_win_prob,
    lp.away_win_prob as attack_score,
    coalesce(lcs.clean_sheet_prob, lp.away_win_prob + 0.5 * lp.draw_prob) as clean_sheet_score,
    lp.source,
    feg.expected_goals
from fixtures f
join game_competitions gc on gc.competition = f.competition
join latest_prob lp on lp.fixture_id = f.id
left join latest_clean_sheet lcs on lcs.fixture_id = f.id and lcs.team_id = f.away_team_id
left join fixture_expected_goals feg on feg.fixture_id = f.id and feg.team_id = f.away_team_id;
