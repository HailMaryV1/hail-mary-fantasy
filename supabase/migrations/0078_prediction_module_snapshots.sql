-- Durable Module Snapshots (Decision Snapshot Architecture) - see the
-- "Durable Module Snapshots" design proposal, 2026-08-01. Closes a real
-- gap found in the platform audit: Fantasy Influence (and any future
-- shadow-weighted module) computes a real per-stat detail block on every
-- projection recompute, but projections.inputs is overwritten in place
-- on every subsequent recompute (upsert_projection's on-conflict-do-
-- update), and predictions only stores an algorithm_version_id pointer,
-- not a copy of what any module computed for the specific players
-- involved. Once a recommendation becomes real (Save Team), this table
-- freezes a verbatim copy so it can eventually be graded historically -
-- append-only, no scoring/grading logic changes here.
--
-- player_role exists because one prediction can reference up to two
-- players with different meanings depending on kind: a transfer's
-- out/in pair, or a captain call's captain/vice_captain pair. hold
-- predictions reference no player and get no snapshot rows - there's
-- nothing to grade a shadow module against for "do nothing".
create table prediction_module_snapshots (
  id bigint generated always as identity primary key,
  prediction_id bigint not null references predictions(id) on delete cascade,
  game_player_id bigint not null references game_players(id) on delete cascade,
  player_role text not null check (player_role in ('out', 'in', 'captain', 'vice_captain')),
  gameweek integer not null,
  algorithm_version_id bigint not null references algorithm_versions(id),
  snapshot_score numeric not null,
  inputs jsonb not null,
  captured_at timestamptz not null default now(),
  unique (prediction_id, game_player_id, player_role)
);

-- Ownership-scoped, not public - inputs carries full projection detail
-- for players who may not belong to the viewing user's own squad.
-- predictions itself scopes ownership via a direct user_id column
-- (migration 0033); this table has no user_id of its own, so its
-- policies join back through prediction_id. No update/delete policy -
-- matching predictions' own immutable-by-design pattern exactly.
alter table prediction_module_snapshots enable row level security;

create policy "own snapshots select" on prediction_module_snapshots for select
  using (exists (
    select 1 from predictions p
    where p.id = prediction_module_snapshots.prediction_id and p.user_id = auth.uid()
  ));

create policy "own snapshots insert" on prediction_module_snapshots for insert
  with check (exists (
    select 1 from predictions p
    where p.id = prediction_module_snapshots.prediction_id and p.user_id = auth.uid()
  ));
