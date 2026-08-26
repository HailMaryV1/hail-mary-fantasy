-- Real user report 2026-08-26 (comparing our Market Odds page against
-- the real bookmaker site side by side): our Crystal Palace/Man City
-- clean sheet % (30%/70%) didn't match the real site's (15%/33%) at
-- all. Root cause (confirmed live, fixed in import_sportmonks_match_
-- odds.py this same session): Premier League's "Clean Sheet" market has
-- a completely different row shape than Championship/League One/League
-- Two's, so it was silently never captured - fixture_clean_sheet_
-- probabilities had ZERO real Premier League rows for the current
-- gameweek, so team_fixture_difficulty's own COALESCE fell back to the
-- win-probability-derived proxy (home_win_prob + 0.5*draw_prob) for
-- EVERY Premier League fixture, indistinguishable from real data on the
-- page - "tricking the eye" in the user's own words.
--
-- The importer bug is fixed, but the user was explicit: "We shouldnt
-- use the fallback - its tricking the eye. IF there is no odds then the
-- market page should say failed to pull odds." This is the honesty
-- fix - exposes WHICH source clean_sheet_score actually came from, the
-- same real/fallback distinction the existing `source` column already
-- gives for win/draw odds, just never extended to the clean-sheet
-- number specifically. Any future gap (a brand new fixture, an API
-- outage, a lower-league match too far out for markets to have posted -
-- see import_sportmonks_match_odds.py's own LOOKAHEAD_DAYS docstring)
-- will now show up honestly instead of silently substituting a number
-- indistinguishable from the real thing.
--
-- New column appended at the END of the select list in both UNION ALL
-- branches - CREATE OR REPLACE VIEW only allows adding columns there,
-- never inserting one before an existing column.
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
    coalesce(lcs.clean_sheet_prob, lp.away_win_prob + 0.5 * lp.draw_prob) as clean_sheet_score,
    lp.source,
    feg.expected_goals,
    case when lcs.clean_sheet_prob is not null then 'real' else 'fdr' end as clean_sheet_source
from fixtures f
join game_competitions gc on gc.competition = f.competition
join latest_prob lp on lp.fixture_id = f.id
left join latest_clean_sheet lcs on lcs.fixture_id = f.id and lcs.team_id = f.away_team_id
left join fixture_expected_goals feg on feg.fixture_id = f.id and feg.team_id = f.away_team_id;
