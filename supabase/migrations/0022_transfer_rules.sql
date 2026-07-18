-- Real FanTeam transfer mechanics, from the user's copy of FanTeam's
-- own rules page:
--   - 1 free transfer per gameweek, banks up to 37 if unused
--   - Transfers beyond the free amount cost -4 points each
--   - 2 wildcards: WC1 usable after GW1's deadline through before GW19's
--     deadline, WC2 after GW19's deadline through before GW38's deadline.
--     Activating a wildcard makes that gameweek's transfers free and
--     resets any banked free transfers to zero.
--
-- squads.free_transfers starts at 1 (a fresh squad's first gameweek).
-- "+1 per gameweek, capped at 37" is NOT automated here - that needs a
-- live "a new gameweek has started" trigger, which doesn't exist until
-- the season is actually running (we're still pre-season, stuck at
-- gameweek 1). Documented as a real gap, not silently assumed away -
-- revisit once there's a way to detect gameweek rollover.

alter table squads add column free_transfers int not null default 1;
alter table squads add column wildcard_1_used_gameweek int;
alter table squads add column wildcard_2_used_gameweek int;

create table squad_transfers (
  id bigint generated always as identity primary key,
  squad_id bigint not null references squads(id) on delete cascade,
  gameweek int not null,
  out_game_player_id bigint not null references game_players(id),
  in_game_player_id bigint not null references game_players(id),
  cost_points numeric(5, 2) not null default 0,
  used_wildcard boolean not null default false,
  created_at timestamptz not null default now()
);

create index on squad_transfers (squad_id, gameweek);

alter table squad_transfers enable row level security;
create policy "own squad transfers select" on squad_transfers for select
  using (exists (select 1 from squads where squads.id = squad_transfers.squad_id and squads.user_id = auth.uid()));
create policy "own squad transfers insert" on squad_transfers for insert
  with check (exists (select 1 from squads where squads.id = squad_transfers.squad_id and squads.user_id = auth.uid()));
