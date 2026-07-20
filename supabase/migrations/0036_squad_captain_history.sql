-- Mary Performance Lab extension - `squads.captain_game_player_id`/
-- `vice_captain_game_player_id` only ever store the CURRENT captain, so
-- once a later gameweek's captain choice overwrites it, a past captain
-- prediction becomes ungradeable ("was Haaland really captained in GW1"
-- can't be answered once GW3's captain has since replaced him there).
-- This is squad_transfers' exact reasoning (migration 0022) applied to
-- captaincy: an append-only history alongside squads' own current-state
-- columns, written every time setCaptain() is called.

create table squad_captain_history (
  id bigint generated always as identity primary key,
  squad_id bigint not null references squads(id) on delete cascade,
  gameweek integer,
  captain_game_player_id bigint not null references game_players(id),
  vice_captain_game_player_id bigint not null references game_players(id),
  created_at timestamptz not null default now()
);

create index on squad_captain_history (squad_id, gameweek);

alter table squad_captain_history enable row level security;
create policy "own captain history select" on squad_captain_history for select
  using (exists (select 1 from squads where squads.id = squad_captain_history.squad_id and squads.user_id = auth.uid()));
create policy "own captain history insert" on squad_captain_history for insert
  with check (exists (select 1 from squads where squads.id = squad_captain_history.squad_id and squads.user_id = auth.uid()));
