-- Real gameweek numbers per fixture, per game - finally replaces the
-- period_start/period_end placeholder (migration 0006) with an actual
-- calendar, now that FanTeam's live season data gives us one directly.
-- Gameweek is inherently game-specific, not a property of the fixture
-- itself (Dream Team's gameweek boundaries can differ from FanTeam's,
-- e.g. from European fixture congestion), so this is a mapping table,
-- not a column on fixtures.

create table game_fixture_gameweeks (
  game_id bigint not null references fantasy_games(id) on delete cascade,
  fixture_id bigint not null references fixtures(id) on delete cascade,
  gameweek int not null,
  primary key (game_id, fixture_id)
);

create index on game_fixture_gameweeks (game_id, gameweek);

alter table game_fixture_gameweeks enable row level security;
create policy "public read" on game_fixture_gameweeks for select using (true);
