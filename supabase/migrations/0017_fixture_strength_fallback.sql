-- Fallback fixture difficulty for matches with no bookmaker match-odds
-- yet (most of the season - real odds only get posted close to
-- matchday). Derived from season-long "to finish top 5" and
-- "relegation" outright odds instead, which exist for the whole
-- season right now. This is a genuinely different, coarser signal than
-- real match odds (a static team strength rating, not "how is this
-- specific matchup shaping up"), so it's kept in its own table and only
-- used when a real fixture_probabilities row doesn't exist - never
-- overwrites real market data.

create table team_season_strength (
  id bigint generated always as identity primary key,
  team_id bigint not null references teams(id),
  season text not null,
  top5_prob numeric(5, 4) not null,       -- normalized so all 20 teams sum to 5
  relegation_prob numeric(5, 4) not null, -- normalized so all 20 teams sum to 3
  strength numeric(6, 4) not null,        -- top5_prob - relegation_prob, roughly -1..1
  source text not null,                   -- e.g. 'quickbet_manual_2026-07-17'
  computed_at timestamptz not null default now(),
  unique (team_id, season)
);

-- Synthetic home/draw/away probability per fixture, derived from both
-- teams' strength ratings via a simple Bradley-Terry-style model - see
-- compute_fixture_strength_probabilities.py for the actual formula.
-- Computed for every fixture up front (regardless of whether real odds
-- exist), so it's always ready as a fallback the moment it's needed.
create table fixture_strength_model_probabilities (
  id bigint generated always as identity primary key,
  fixture_id bigint not null references fixtures(id) on delete cascade,
  home_win_prob numeric(5, 4) not null,
  draw_prob numeric(5, 4) not null,
  away_win_prob numeric(5, 4) not null,
  computed_at timestamptz not null default now()
);

create index on fixture_strength_model_probabilities (fixture_id, computed_at desc);

alter table team_season_strength enable row level security;
alter table fixture_strength_model_probabilities enable row level security;
create policy "public read" on team_season_strength for select using (true);
create policy "public read" on fixture_strength_model_probabilities for select using (true);

-- team_fixture_difficulty now prefers real match odds per fixture, and
-- only falls back to the strength-model estimate when no real odds
-- exist for that specific fixture yet - a per-fixture COALESCE, not a
-- global switch, so fixtures naturally upgrade to real odds as they're
-- posted closer to matchday.
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
-- Only fixtures where at least one source has data - keeps the "no
-- data at all yet" case absent from the view entirely (as before),
-- rather than present with null scores that downstream code
-- (compute_projections.py) doesn't expect.
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
        coalesce(lr.away_win_prob, ls.away_win_prob) as away_win_prob
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
