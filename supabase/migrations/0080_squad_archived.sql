-- Some squads are genuinely done - a completed golf tournament (each
-- FanTeam Golf entry is a one-off event, never re-entered) has nothing
-- left to sync, price-check, or project a next gameweek for, yet
-- getSquadStatuses (frontend/src/lib/squadStatus.ts) still ran a real
-- budget/next-gameweek-score computation for every one of them on every
-- page load, same as a live season-long squad - confirmed live
-- (2026-08-03) that with 16 real squads (11 of them completed golf
-- entries) this was the dominant cost behind a slow-feeling site. This
-- flag lets getSquadStatuses skip archived squads entirely - the
-- historical "what was projected vs what actually happened" data they
-- still exist for lives in golf_tournament_predictions and is read
-- directly by /golf/algorithm-performance (frontend/src/app/golf/
-- algorithm-performance/page.tsx), which does NOT filter on this column
-- and is completely unaffected by archiving.
--
-- Same "still a normal squads row, only a UI/computation-scope flag"
-- shape as is_scratch (migration 0059) - nothing else about a squad's
-- infrastructure changes.
alter table squads add column is_archived boolean not null default false;

create index on squads (user_id, is_archived);
