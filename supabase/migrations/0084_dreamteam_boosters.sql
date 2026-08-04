-- Real Dream Team booster/substitute rules, from the user's copy of Dream
-- Team's own official rules doc (section 1.2.5.8-1.2.5.9):
--   - 3 Boosters, each usable exactly ONCE per season (not per-gameweek
--     like a wildcard): Goal Bonus, 12th Man, Max Captain. Only one can be
--     active in any given gameweek. Can be deselected/changed up until
--     that gameweek's deadline, same as squads.wildcard_1/2_used_gameweek's
--     pattern for FanTeam - active_booster/active_booster_gameweek is the
--     current pending choice, the three *_used_gameweek columns are the
--     permanent once-locked record.
--   - Locking a pending booster into a permanent used_gameweek happens
--     once that gameweek's deadline passes - same known gap as migration
--     0022's free-transfer accrual (no live gameweek-rollover trigger
--     exists yet). Not automated here; revisit together.
--   - Substitute feature: up to 10 uses per season, one per gameweek,
--     swaps a non-playing starter for a not-yet-played player after the
--     gameweek deadline. Modeled as an append-only log (squad_substitutions)
--     rather than a counter column, mirroring squad_transfers' shape -
--     the count of rows IS the season-to-date usage.
--   - 12th Man adds one extra scoring player outside the normal starting
--     XI/formation for that gameweek only - squad_players.is_twelfth_man
--     flags it, default false so every other game/row is unaffected.
--
-- Dream-Team-specific in practice (same precedent as FanTeam's wildcard
-- columns sitting unused on every other game's squads rows) - these stay
-- generic on the shared squads/squad_players tables rather than a
-- dreamteam-only side table, since squads is already the established home
-- for per-game rule-specific columns.

alter table squads add column active_booster text check (active_booster in ('goal_bonus', 'twelfth_man', 'max_captain'));
alter table squads add column active_booster_gameweek int;
alter table squads add column goal_bonus_used_gameweek int;
alter table squads add column twelfth_man_used_gameweek int;
alter table squads add column max_captain_used_gameweek int;

alter table squad_players add column is_twelfth_man boolean not null default false;

create table squad_substitutions (
  id bigint generated always as identity primary key,
  squad_id bigint not null references squads(id) on delete cascade,
  gameweek int not null,
  out_game_player_id bigint not null references game_players(id),
  in_game_player_id bigint not null references game_players(id),
  created_at timestamptz not null default now()
);

create index on squad_substitutions (squad_id, gameweek);

alter table squad_substitutions enable row level security;
create policy "own squad substitutions select" on squad_substitutions for select
  using (exists (select 1 from squads where squads.id = squad_substitutions.squad_id and squads.user_id = auth.uid()));
create policy "own squad substitutions insert" on squad_substitutions for insert
  with check (exists (select 1 from squads where squads.id = squad_substitutions.squad_id and squads.user_id = auth.uid()));
