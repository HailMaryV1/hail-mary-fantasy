-- Wires real bookmaker clean-sheet odds into team_fixture_difficulty,
-- replacing the win/draw approximation whenever the real market exists.
--
-- A "Team X total goals Under 0.5" price *is* the clean-sheet market for
-- X's opponent (X scoring 0 means the opponent didn't concede) - so
-- fixture_clean_sheet_probabilities stores results keyed by the team
-- that KEEPS the clean sheet, resolved from the other side's 0.5-line
-- market. Populated by compute_clean_sheet_probabilities.py, which only
-- uses exact 0.5 lines - a 1.5 line answers "0 or 1 goals", a different
-- question, and mixing it in would just be a second approximation.
--
-- team_fixture_difficulty now COALESCEs: real market first, win/draw
-- approximation only when no 0.5-line market exists yet for that fixture.

create table fixture_clean_sheet_probabilities (
  id bigint generated always as identity primary key,
  fixture_id bigint not null references fixtures(id) on delete cascade,
  team_id bigint not null references teams(id),
  clean_sheet_prob numeric(5, 4) not null,
  bookmaker_count int not null,
  computed_at timestamptz not null default now()
);

create index on fixture_clean_sheet_probabilities (fixture_id, team_id, computed_at desc);

alter table fixture_clean_sheet_probabilities enable row level security;
create policy "public read" on fixture_clean_sheet_probabilities for select using (true);

create or replace view team_fixture_difficulty as
with latest_prob as (
    select distinct on (fixture_id)
        fixture_id, home_win_prob, draw_prob, away_win_prob
    from fixture_probabilities
    order by fixture_id, computed_at desc
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
    coalesce(lcs.clean_sheet_prob, lp.home_win_prob + 0.5 * lp.draw_prob) as clean_sheet_score
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
    coalesce(lcs.clean_sheet_prob, lp.away_win_prob + 0.5 * lp.draw_prob) as clean_sheet_score
from fixtures f
join game_competitions gc on gc.competition = f.competition
join latest_prob lp on lp.fixture_id = f.id
left join latest_clean_sheet lcs on lcs.fixture_id = f.id and lcs.team_id = f.away_team_id;
