-- Tournament odds for Hail Mary Golf - manually sourced, like course
-- history. The Odds API (already used for football/NFL) only covers the
-- 4 major championships for golf, outright-winner only - no coverage at
-- all for the regular weekly PGA Tour events this game is actually built
-- around, confirmed live against their /sports endpoint. A dedicated
-- golf-odds API (DataGolf Scratch Plus, SportsDataIO, Odds88) would cover
-- it properly, but the user doesn't want a standing subscription just for
-- a once-a-week "rough idea of the market" - a bookmaker/odds-aggregator
-- page (e.g. oddschecker's real "3M Open Winner"/"Top 20 Finish" pages)
-- is free to view and gets copy-pasted in instead, same manual pattern as
-- course history and the FanTeam scoring rules.
--
-- Tournament-scoped (like golf_tournament_entries), not course-scoped
-- (unlike golf_course_history_entries) - odds are inherently about this
-- specific week's field and market, not a reusable property of a venue.
create table golf_tournament_odds (
  id bigint generated always as identity primary key,
  tournament_id bigint not null references golf_tournaments(id) on delete cascade,
  golfer_id bigint references golfers(id),
  raw_player_name text not null,
  market text not null, -- 'win' | 'top5' | 'top10' | 'top20'
  decimal_odds numeric,
  implied_probability numeric,
  source text not null default 'bookmaker',
  captured_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (tournament_id, raw_player_name, market)
);

alter table golf_tournament_odds enable row level security;
create policy "public read" on golf_tournament_odds for select using (true);

create index golf_tournament_odds_golfer_id_idx on golf_tournament_odds (golfer_id);
