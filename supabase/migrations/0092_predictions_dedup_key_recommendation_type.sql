-- predictions_dedup_key (migration 0041) doesn't include
-- recommendation_type, so two DIFFERENT recommendation streams for the
-- same squad that happen to share (gameweek, algorithm_version_id,
-- planning_horizon, strategy, kind, rank) collide and the second insert
-- is silently treated as "already recorded" (recordPredictions catches
-- 23505 as expected, not an error - see predictionActions.ts).
--
-- Every existing engine only ever produces one recommendation_type per
-- (gameweek, horizon, kind) combination, so this never fired before.
-- eflfantasyAskMaryEngine.ts is the first to produce two genuinely
-- independent streams for the same squad - 'gw_plan' (player transfers)
-- and 'club_pick' (club swaps) - which both use kind='hold'/'transfer'
-- and can land on the same gameweek/horizon/rank. Caught live: a GW1
-- club-pick hold silently failed to archive because a GW1 gw_plan hold
-- had already claimed that key.
--
-- No dedup pass needed before rebuilding - the OLD (coarser) index
-- already guaranteed every existing row is unique on its columns, so
-- adding one more column to the index can only relax uniqueness, never
-- create a new conflict among rows that already exist.
drop index predictions_dedup_key;

create unique index predictions_dedup_key on predictions (
  user_id, squad_id, coalesce(gameweek, -1), coalesce(algorithm_version_id, -1),
  planning_horizon, strategy, kind, recommendation_type, coalesce(rank, 0)
);
