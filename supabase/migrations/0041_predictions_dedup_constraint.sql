-- recordPredictions (frontend/src/app/ask-mary/actions.ts) checked "does a
-- row matching this batch's key already exist" with a plain SELECT, then
-- inserted the whole batch if not - a classic check-then-act race with no
-- database backing it up. performance-lab/page.tsx re-runs the whole Ask
-- Mary analysis (and re-archives it) on every page load, so two
-- near-simultaneous loads could both pass the SELECT before either INSERT
-- committed, duplicating every leg of the batch. Caught from the
-- Performance Lab UI showing every recommendation twice.
--
-- Fix is two-part: first collapse any duplicates already written (keep the
-- lowest id per natural key - the first one ever recorded), then add a
-- real unique index on that same key so the race can't recur. The index is
-- per-ROW, not per-batch - each leg of a legitimate multi-transfer
-- gameweek still gets its own row because `rank` differs - only true
-- duplicates (identical key including rank) collide. COALESCE normalizes
-- the nullable columns (gameweek/algorithm_version_id/rank) since two NULLs
-- are never equal to each other under a plain unique index, which would
-- otherwise let hold/captain-shaped duplicates (rank always null) through.

delete from predictions p
where p.id not in (
  select min(p2.id)
  from predictions p2
  group by
    p2.user_id, p2.squad_id, coalesce(p2.gameweek, -1),
    coalesce(p2.algorithm_version_id, -1), p2.planning_horizon,
    p2.strategy, p2.kind, coalesce(p2.rank, 0)
);

create unique index predictions_dedup_key on predictions (
  user_id, squad_id, coalesce(gameweek, -1), coalesce(algorithm_version_id, -1),
  planning_horizon, strategy, kind, coalesce(rank, 0)
);
