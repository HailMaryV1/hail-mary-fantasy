-- Cloud FF's real captain rule is not "one captain per gameweek" like
-- FanTeam/Dream Team - it's one captain PER CALENDAR MATCH-DAY, chosen
-- only from squad players who have a real fixture kicking off that
-- specific day (confirmed live against the real site's own dedicated
-- "Captains" page and a reference planner, auto-picked when only one
-- player qualifies that day). squads.captain_game_player_id/
-- vice_captain_game_player_id and squad_captain_history (gameweek-keyed,
-- migration 0036) can only ever hold ONE current pick - structurally
-- can't represent "a different captain legally applies Friday vs Sunday
-- within the same gameweek."
--
-- Purely additive: FanTeam/Dream Team's real rules genuinely are single-
-- captain-per-gameweek, so squads.captain_game_player_id/
-- squad_captain_history keep serving them completely unchanged. Cloud FF
-- is the only game that reads/writes this new table - see
-- setMatchDayCaptain (squads/actions.ts) and squads/[id]/captains/page.tsx.
create table squad_match_day_captains (
  id bigint generated always as identity primary key,
  squad_id bigint not null references squads(id) on delete cascade,
  match_date date not null,
  captain_game_player_id bigint not null references game_players(id),
  vice_captain_game_player_id bigint references game_players(id),
  auto_picked boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (squad_id, match_date)
);

create index on squad_match_day_captains (squad_id, match_date);

alter table squad_match_day_captains enable row level security;
create policy "own match day captains select" on squad_match_day_captains for select
  using (exists (select 1 from squads where squads.id = squad_match_day_captains.squad_id and squads.user_id = auth.uid()));
create policy "own match day captains insert" on squad_match_day_captains for insert
  with check (exists (select 1 from squads where squads.id = squad_match_day_captains.squad_id and squads.user_id = auth.uid()));
create policy "own match day captains update" on squad_match_day_captains for update
  using (exists (select 1 from squads where squads.id = squad_match_day_captains.squad_id and squads.user_id = auth.uid()));
