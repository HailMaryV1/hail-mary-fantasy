-- Projected cup/Europe fixtures for Target Score's Fixture Quantity
-- (2026-08-27 user request - "the fixture tickers show all the double
-- gameweeks coming up... it would massively help our fixture QUANTITY
-- even when the game is not populated themselves"). Dream Team Tonic's
-- own fixture ticker (/tools/sdt-fixtures) already projects a team's
-- likely-upcoming cup/Europe involvement before we have a real,
-- opponent-confirmed fixture row for it - TBA (a real, date-confirmed
-- fixture, e.g. a fixed UEFA league-phase matchday, opponent just not
-- drawn yet) and IF (contingent on the team actually progressing past
-- the current cup round - genuinely uncertain, so only half-weighted).
-- Dream Team only - confirmed directly by the user that FanTeam/Cloud
-- FF both only ever score Premier League matches, real, regardless of
-- what any other game's own ticker page happens to display.
create table dreamteamtonic_projected_fixtures (
  id bigint generated always as identity primary key,
  game_id bigint not null references fantasy_games(id) on delete cascade,
  team_id bigint not null references teams(id),
  gameweek integer not null,
  competition text not null,       -- 'soccer_uefa_champs_league' etc - same values fixtures.competition already uses
  confidence numeric(3, 2) not null check (confidence in (0.5, 1.0)),  -- IF = 0.5, TBA = 1.0
  captured_at timestamptz not null default now(),
  unique (game_id, team_id, gameweek, competition)
);

create index on dreamteamtonic_projected_fixtures (game_id, gameweek);

alter table dreamteamtonic_projected_fixtures enable row level security;
create policy "public read" on dreamteamtonic_projected_fixtures for select using (true);
-- No insert/update/delete policy for anon/authenticated - only the
-- pipeline's service-role connection writes.
