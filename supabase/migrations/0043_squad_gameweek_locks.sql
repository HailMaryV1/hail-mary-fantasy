-- "Save Team" - predictions used to get re-archived on every single Ask
-- Mary / Performance Lab page view (runAskMaryAnalysis's
-- recordPredictionsFn parameter was always wired up), which produced a
-- new "recommendation" every time the user so much as looked at a
-- different strategy while still deciding what to do - Performance Lab's
-- Recommendation History became mostly noise from mid-tinkering, not
-- genuine decisions, and gave no honest answer to "did I actually follow
-- this" since the squad was still changing after the fact.
--
-- This table is the new explicit trigger: a "Save Team" button the user
-- presses once they've actually locked their squad in on the real
-- FanTeam site for a given gameweek - that's the one moment a prediction
-- snapshot means anything, since only then is "what Mary suggested"
-- being compared against a squad that's genuinely final.
--
-- lineup_snapshot captures the locked starting XI + bench order at that
-- exact moment, not just a timestamp - squad_players.is_starting/
-- bench_order are live, current-state columns that keep changing as the
-- user plans future gameweeks, so without a snapshot the historical
-- record of "who actually started GW3" would be lost the moment GW4
-- lineup edits began. Same append-only-history-alongside-live-state
-- pattern as squad_transfers/squad_captain_history (migrations 0022/0036).
--
-- unique(squad_id, gameweek) with upsert semantics (not insert-only) -
-- the user presses this once they've locked in on the real site, but may
-- reasonably press it again before the real deadline passes if they
-- change their mind, so re-saving the same gameweek updates the snapshot
-- rather than erroring.

create table squad_gameweek_locks (
  id bigint generated always as identity primary key,
  squad_id bigint not null references squads(id) on delete cascade,
  gameweek integer not null,
  locked_at timestamptz not null default now(),
  lineup_snapshot jsonb not null,
  unique (squad_id, gameweek)
);

create index on squad_gameweek_locks (squad_id, gameweek);

alter table squad_gameweek_locks enable row level security;
create policy "own gameweek locks select" on squad_gameweek_locks for select
  using (exists (select 1 from squads where squads.id = squad_gameweek_locks.squad_id and squads.user_id = auth.uid()));
create policy "own gameweek locks insert" on squad_gameweek_locks for insert
  with check (exists (select 1 from squads where squads.id = squad_gameweek_locks.squad_id and squads.user_id = auth.uid()));
create policy "own gameweek locks update" on squad_gameweek_locks for update
  using (exists (select 1 from squads where squads.id = squad_gameweek_locks.squad_id and squads.user_id = auth.uid()));
