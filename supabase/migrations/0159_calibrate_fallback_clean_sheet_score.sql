-- Real user report 2026-08-27 (screenshot): Leeds' GW3 trip to Newcastle
-- showed as "very tough" while Crystal Palace hosting Manchester City -
-- objectively the toughest fixture in the league that week - only showed
-- "tough". Root cause traced to team_fixture_difficulty (migration 0017,
-- most recently redefined by 0149): Newcastle's win_prob (0.5841) came
-- from the strength-model fallback (no real bookmaker odds posted yet,
-- 18 days out) with no real per-team clean_sheet_prob either, so
-- clean_sheet_score fell back to `win_prob + 0.5*draw_prob` = 0.7041.
-- Man City's fixture (10 days out) already had REAL market odds for both
-- win_prob (0.5728, nearly identical to Newcastle's) AND clean_sheet_prob
-- (0.3810, a genuine market figure) - so two teams with almost the same
-- win probability produced wildly different difficulty because one used
-- a real number and the other used a structurally-biased proxy.
--
-- The proxy is mathematically "P(team does not lose)" (win + half the
-- draw share), which is a fundamentally different quantity from "P(team
-- keeps a clean sheet)" - a team can win 3-2 or draw 1-1 with zero clean
-- sheets. Confirmed empirically against every fixture that has BOTH a
-- real win_prob AND a real clean_sheet_prob (64,264 real rows, home+away
-- both sides, bucketed by win_prob in 0.05 steps, n=576 to 9955 per
-- bucket): the naive formula overestimates real clean_sheet_prob by
-- 0.14-0.31 at every single bucket, worst in the middle of the range
-- (exactly where Newcastle's 0.58 sat).
--
-- Fixed the same way this codebase already calibrates fixtureDifficultyColor.ts
-- and Target Score's own sub-rating thresholds: measure the real
-- distribution once, freeze it as a lookup, revisit periodically. The
-- fallback keeps pulling from this project's own Team Strength tool
-- (compute_fixture_strength_probabilities.py / team_season_strength,
-- adjustable via the Team Strength admin page) exactly as before - only
-- the clean-sheet CONVERSION applied to that fallback's win_prob changes,
-- not its source. Real market clean_sheet_prob (fixture_clean_sheet_
-- probabilities) still wins outright via COALESCE whenever it exists,
-- completely unchanged - and clean_sheet_source (migration 0149) still
-- honestly reports 'fdr' either way, just a far more accurate 'fdr'
-- number now.
create or replace function calibrated_clean_sheet_prob(win_prob numeric)
returns numeric
language sql
immutable
as $$
    select case
        when win_prob <= 0.05 then 0.1111
        when win_prob <= 0.10 then 0.1111 + (win_prob - 0.05) / 0.05 * (0.1258 - 0.1111)
        when win_prob <= 0.15 then 0.1258 + (win_prob - 0.10) / 0.05 * (0.1476 - 0.1258)
        when win_prob <= 0.20 then 0.1476 + (win_prob - 0.15) / 0.05 * (0.1894 - 0.1476)
        when win_prob <= 0.25 then 0.1894 + (win_prob - 0.20) / 0.05 * (0.2291 - 0.1894)
        when win_prob <= 0.30 then 0.2291 + (win_prob - 0.25) / 0.05 * (0.2581 - 0.2291)
        when win_prob <= 0.35 then 0.2581 + (win_prob - 0.30) / 0.05 * (0.2817 - 0.2581)
        when win_prob <= 0.40 then 0.2817 + (win_prob - 0.35) / 0.05 * (0.3121 - 0.2817)
        when win_prob <= 0.45 then 0.3121 + (win_prob - 0.40) / 0.05 * (0.3428 - 0.3121)
        when win_prob <= 0.50 then 0.3428 + (win_prob - 0.45) / 0.05 * (0.3513 - 0.3428)
        when win_prob <= 0.55 then 0.3513 + (win_prob - 0.50) / 0.05 * (0.3880 - 0.3513)
        when win_prob <= 0.60 then 0.3880 + (win_prob - 0.55) / 0.05 * (0.3927 - 0.3880)
        when win_prob <= 0.65 then 0.3927 + (win_prob - 0.60) / 0.05 * (0.4689 - 0.3927)
        when win_prob <= 0.70 then 0.4689 + (win_prob - 0.65) / 0.05 * (0.4898 - 0.4689)
        when win_prob <= 0.75 then 0.4898 + (win_prob - 0.70) / 0.05 * (0.5148 - 0.4898)
        when win_prob <= 0.80 then 0.5148 + (win_prob - 0.75) / 0.05 * (0.6407 - 0.5148)
        -- Flat-clamped beyond the observed real range (max real win_prob
        -- seen was 0.8143) - no real data past this point to extrapolate
        -- from, so hold the last observed value rather than guess.
        else 0.6407
    end
$$;

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
    coalesce(lcs.clean_sheet_prob, calibrated_clean_sheet_prob(lp.home_win_prob)) as clean_sheet_score,
    lp.source,
    feg.expected_goals,
    case when lcs.clean_sheet_prob is not null then 'real' else 'fdr' end as clean_sheet_source
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
    coalesce(lcs.clean_sheet_prob, calibrated_clean_sheet_prob(lp.away_win_prob)) as clean_sheet_score,
    lp.source,
    feg.expected_goals,
    case when lcs.clean_sheet_prob is not null then 'real' else 'fdr' end as clean_sheet_source
from fixtures f
join game_competitions gc on gc.competition = f.competition
join latest_prob lp on lp.fixture_id = f.id
left join latest_clean_sheet lcs on lcs.fixture_id = f.id and lcs.team_id = f.away_team_id
left join fixture_expected_goals feg on feg.fixture_id = f.id and feg.team_id = f.away_team_id;
