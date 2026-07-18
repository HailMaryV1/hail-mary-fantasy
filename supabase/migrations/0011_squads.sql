-- Squad-building rules per game, and the actual user-owned squads.
--
-- The two games have genuinely different shapes, confirmed with the user
-- rather than assumed:
--   - Dream Team: 11 players, no bench, £50m budget. No fixed position
--     quota - you pick a FORMATION (4-4-2, 3-5-2, etc.) which fixes the
--     GK/DEF/MID/FWD counts for that squad. No max-players-per-club limit
--     was found in the rules and the user didn't add one - left
--     unconstrained for now, easy to add later if that's wrong.
--   - FanTeam: 15 players (11 start, 4 bench), user-estimated £100m budget
--     (flagged as a guess, not confirmed against FanTeam's own rules page -
--     trivial to correct, it's just a config value). Fixed quota: 2 GK,
--     5 DEF, 5 MID, 3 FWD. Max 3 players from one club.
--
-- game_squad_rules holds both shapes: gk_quota etc. are set directly for
-- fixed-quota games (FanTeam), left null for formation-based games
-- (Dream Team) where game_formations supplies the quota instead.

create table game_squad_rules (
  game_id bigint primary key references fantasy_games(id) on delete cascade,
  squad_size int not null,
  starting_size int not null,
  budget numeric(6, 2) not null,
  max_per_club int,               -- null = unconstrained
  uses_formations boolean not null default false,
  gk_quota int,                   -- set only when uses_formations = false
  def_quota int,
  mid_quota int,
  fwd_quota int
);

create table game_formations (
  id bigint generated always as identity primary key,
  game_id bigint not null references fantasy_games(id) on delete cascade,
  code text not null,             -- e.g. '4-4-2'
  gk_count int not null,
  def_count int not null,
  mid_count int not null,
  fwd_count int not null,
  unique (game_id, code)
);

create table squads (
  id bigint generated always as identity primary key,
  user_id uuid not null references auth.users(id) on delete cascade,
  game_id bigint not null references fantasy_games(id),
  name text not null default 'My Squad',
  formation_id bigint references game_formations(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table squad_players (
  id bigint generated always as identity primary key,
  squad_id bigint not null references squads(id) on delete cascade,
  game_player_id bigint not null references game_players(id) on delete cascade,
  unique (squad_id, game_player_id)
);

create index on squads (user_id);
create index on squad_players (squad_id);

-- Reference/config data - public read like game_competitions etc.
alter table game_squad_rules enable row level security;
alter table game_formations enable row level security;
create policy "public read" on game_squad_rules for select using (true);
create policy "public read" on game_formations for select using (true);

-- Squads are personal - only their owner can see or touch them.
alter table squads enable row level security;
alter table squad_players enable row level security;

create policy "own squads select" on squads for select using (auth.uid() = user_id);
create policy "own squads insert" on squads for insert with check (auth.uid() = user_id);
create policy "own squads update" on squads for update using (auth.uid() = user_id);
create policy "own squads delete" on squads for delete using (auth.uid() = user_id);

create policy "own squad players select" on squad_players for select
  using (exists (select 1 from squads where squads.id = squad_players.squad_id and squads.user_id = auth.uid()));
create policy "own squad players insert" on squad_players for insert
  with check (exists (select 1 from squads where squads.id = squad_players.squad_id and squads.user_id = auth.uid()));
create policy "own squad players delete" on squad_players for delete
  using (exists (select 1 from squads where squads.id = squad_players.squad_id and squads.user_id = auth.uid()));
