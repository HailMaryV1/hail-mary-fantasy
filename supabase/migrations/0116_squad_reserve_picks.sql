-- EFL Fantasy has no bench at all (see migration 0089's docstring) - if a
-- starter gets last-minute bad news, there's nothing in the data model to
-- fall back on. The user researches backup options themselves per
-- position (DEF/MID/FWD only - GK doesn't matter to them) and wants that
-- shortlist to persist week to week, ranked by preference, so a real
-- swap-in is one click instead of re-searching the pool from scratch.
--
-- Scoped to squad_id, not (user_id, game_id) like watchlist_entries
-- (migration 0028) - this is explicitly about backing up THIS squad's
-- specific picks, not a general "players I'm watching" list. Not
-- eflfantasy-specific in name/shape (any bench-less game could reuse it
-- later), but only EFL Fantasy's UI reads/writes it today - see this
-- project's per-game-independent-identity convention.
--
-- rank has no unique constraint - reordering is done by the app replacing
-- a whole position's list in one go (delete + reinsert with sequential
-- ranks), which is simpler and safer than juggling a live uniqueness
-- constraint through a multi-row reorder.
create table squad_reserve_picks (
  id bigint generated always as identity primary key,
  squad_id bigint not null references squads(id) on delete cascade,
  position text not null check (position in ('DEF', 'MID', 'FWD')),
  game_player_id bigint not null references game_players(id) on delete cascade,
  rank int not null,
  added_at timestamptz not null default now(),
  unique (squad_id, game_player_id)
);

create index on squad_reserve_picks (squad_id, position, rank);

alter table squad_reserve_picks enable row level security;

create policy "own reserve picks select" on squad_reserve_picks for select
  using (exists (select 1 from squads where squads.id = squad_reserve_picks.squad_id and squads.user_id = auth.uid()));
create policy "own reserve picks insert" on squad_reserve_picks for insert
  with check (exists (select 1 from squads where squads.id = squad_reserve_picks.squad_id and squads.user_id = auth.uid()));
create policy "own reserve picks update" on squad_reserve_picks for update
  using (exists (select 1 from squads where squads.id = squad_reserve_picks.squad_id and squads.user_id = auth.uid()));
create policy "own reserve picks delete" on squad_reserve_picks for delete
  using (exists (select 1 from squads where squads.id = squad_reserve_picks.squad_id and squads.user_id = auth.uid()));
