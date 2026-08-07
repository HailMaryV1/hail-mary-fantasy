-- Exposes which COALESCE branch (migration 0017) actually won for each
-- team_fixture_difficulty row, so the frontend can show "live bookmaker
-- odds" vs "Mary's FDR estimate" per fixture instead of that being
-- invisible inside the view. Real odds (fixture_probabilities) still
-- always win when present - this only surfaces which one happened,
-- it doesn't change which one happened. Automatically reflects live
-- state on every page load (no caching layer here to invalidate) - the
-- moment real odds get posted for a fixture, the very next refresh
-- read of this view flips that fixture from 'fdr' to 'real_odds'.

create or replace view team_fixture_difficulty as
with latest_real_prob as (
    select distinct on (fixture_id)
        fixture_id, home_win_prob, draw_prob, away_win_prob
    from fixture_probabilities
    order by fixture_id, computed_at desc
),
latest_strength_prob as (
    select distinct on (fixture_id)
        fixture_id, home_win_prob, draw_prob, away_win_prob
    from fixture_strength_model_probabilities
    order by fixture_id, computed_at desc
),
fixtures_with_data as (
    select fixture_id from latest_real_prob
    union
    select fixture_id from latest_strength_prob
),
latest_prob as (
    select
        fwd.fixture_id,
        coalesce(lr.home_win_prob, ls.home_win_prob) as home_win_prob,
        coalesce(lr.draw_prob, ls.draw_prob) as draw_prob,
        coalesce(lr.away_win_prob, ls.away_win_prob) as away_win_prob,
        case when lr.fixture_id is not null then 'real_odds' else 'fdr' end as source
    from fixtures_with_data fwd
    left join latest_real_prob lr on lr.fixture_id = fwd.fixture_id
    left join latest_strength_prob ls on ls.fixture_id = fwd.fixture_id
),
latest_clean_sheet as (
    select distinct on (fixture_id, team_id)
        fixture_id, team_id, clean_sheet_prob
    from fixture_clean_sheet_probabilities
    order by fixture_id, team_id, computed_at desc
)
select
    gc.game_id,
    f.id as fixture_id,
    f.competition,
    f.kickoff_at,
    f.home_team_id as team_id,
    lp.home_win_prob as team_win_prob,
    lp.draw_prob,
    lp.away_win_prob as opponent_win_prob,
    lp.home_win_prob as attack_score,
    coalesce(lcs.clean_sheet_prob, lp.home_win_prob + 0.5 * lp.draw_prob) as clean_sheet_score,
    lp.source
from fixtures f
join game_competitions gc on gc.competition = f.competition
join latest_prob lp on lp.fixture_id = f.id
left join latest_clean_sheet lcs on lcs.fixture_id = f.id and lcs.team_id = f.home_team_id

union all

select
    gc.game_id,
    f.id as fixture_id,
    f.competition,
    f.kickoff_at,
    f.away_team_id as team_id,
    lp.away_win_prob as team_win_prob,
    lp.draw_prob,
    lp.home_win_prob as opponent_win_prob,
    lp.away_win_prob as attack_score,
    coalesce(lcs.clean_sheet_prob, lp.away_win_prob + 0.5 * lp.draw_prob) as clean_sheet_score,
    lp.source
from fixtures f
join game_competitions gc on gc.competition = f.competition
join latest_prob lp on lp.fixture_id = f.id
left join latest_clean_sheet lcs on lcs.fixture_id = f.id and lcs.team_id = f.away_team_id;
