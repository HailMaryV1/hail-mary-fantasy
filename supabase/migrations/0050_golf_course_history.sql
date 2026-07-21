-- Course history for Hail Mary Golf - the gap flagged (and deliberately
-- left unbuilt) in the original FanTeam Golf plan: FanTeam's own API has
-- no course/venue name and no course-specific "how have they scored HERE
-- before" signal, only golfers' global career stats. The user found a
-- real, well-modeled source for this - DataGolf's Course History tool
-- (datagolf.com/course-history-tool) - and chose the same manual-import
-- pattern already used for FanTeam's scoring rules: DataGolf's API needs
-- a paid "Scratch Plus" subscription, so rather than scrape their site
-- (a commercial paid-data company - not something to do without a real
-- API relationship), the user downloads that tool's CSV export each week
-- for the upcoming tournament's course and uploads it here.
--
-- Deliberately a course-scoped table, not tournament-scoped like
-- golf_tournament_entries - course history is a property of the course
-- itself (a course a tour visits repeatedly, e.g. TPC Twin Cities hosting
-- the 3M Open every year), not of one specific tournament instance. A
-- golf_tournaments row links to the course it's played at via the new
-- nullable course_id column - nullable because FanTeam gives us no course
-- name at all, so this only gets populated once someone manually links a
-- tournament to a course via the course-history import page.
create table golf_courses (
  id bigint generated always as identity primary key,
  name text not null unique,
  created_at timestamptz not null default now()
);

alter table golf_courses enable row level security;
create policy "public read" on golf_courses for select using (true);

alter table golf_tournaments
  add column course_id bigint references golf_courses(id);

-- One row per (course, golfer) - re-uploading the same course's CSV later
-- in the season (DataGolf's export is a rolling last-5-years window, so
-- values genuinely change week to week) safely upserts on this key rather
-- than duplicating history.
--
-- golfer_id is nullable: DataGolf's own field is broader than any single
-- FanTeam tournament's pool (this file's rows include players who've
-- never entered a FanTeam contest at all), so a good number of rows will
-- have no matching golfers row yet - raw_player_name is kept regardless
-- so the row isn't silently dropped, and match rate is surfaced in the
-- import summary rather than assumed.
create table golf_course_history_entries (
  id bigint generated always as identity primary key,
  course_id bigint not null references golf_courses(id) on delete cascade,
  golfer_id bigint references golfers(id),
  raw_player_name text not null,
  rounds_played integer,
  historical_true_sg numeric,
  versus_expected numeric,
  ch_adjustment numeric,
  experience_adjustment numeric,
  year_finishes jsonb,
  source text not null default 'datagolf',
  captured_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (course_id, raw_player_name)
);

alter table golf_course_history_entries enable row level security;
create policy "public read" on golf_course_history_entries for select using (true);

create index golf_course_history_entries_golfer_id_idx on golf_course_history_entries (golfer_id);
