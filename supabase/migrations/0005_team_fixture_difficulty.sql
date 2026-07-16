-- Per-team, per-fixture difficulty/opportunity signal - the actual
-- fixture-quantity + fixture-quality combination discussed from the
-- start of this work.
--
-- Built as a view, not a stored table: it's fully derivable from
-- fixtures + fixture_probabilities + game_competitions, so storing it
-- separately would just be a second copy that could go stale as odds
-- move. One row per (game, team, fixture) - a team with 2 fixtures in a
-- gameweek naturally gets 2 rows, so summing attack_score/clean_sheet_score
-- over a date range captures quantity and quality together: 2 fixtures
-- against so-so opponents can outscore 1 fixture against a weak one,
-- without needing a separate "quantity multiplier" bolted on.
--
-- attack_score: this team's own win probability. A blunt proxy for now
-- (stronger favourite -> more expected attacking returns) - upgraded to
-- real expected-goals data once fixture_team_totals actually has rows
-- (see migration 0004).
-- clean_sheet_score: win% + half of draw% - the agreed default
-- approximation, same caveat as above (fixture_team_totals will replace
-- this with the real team-goals-against market once it's populated).
--
-- We only join fixtures through game_competitions, so a fixture from a
-- competition a game doesn't score (e.g. FA Cup for FanTeam) simply
-- never appears for that game - no filtering logic needed elsewhere.

create view team_fixture_difficulty as
with latest_prob as (
    select distinct on (fixture_id)
        fixture_id, home_win_prob, draw_prob, away_win_prob
    from fixture_probabilities
    order by fixture_id, computed_at desc
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
    lp.home_win_prob + 0.5 * lp.draw_prob as clean_sheet_score
from fixtures f
join game_competitions gc on gc.competition = f.competition
join latest_prob lp on lp.fixture_id = f.id

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
    lp.away_win_prob + 0.5 * lp.draw_prob as clean_sheet_score
from fixtures f
join game_competitions gc on gc.competition = f.competition
join latest_prob lp on lp.fixture_id = f.id;
