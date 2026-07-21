-- FanTeam auto-substitution priority: if a starter doesn't feature in a
-- gameweek, the highest-priority bench player who still leaves a legal
-- formation comes on automatically - if that one doesn't fit either
-- (formation would become illegal), the next-priority one is tried, and
-- so on. 1/2/3 for the 3 outfield bench spots (squad_size 15 - starting_size
-- 11 = 4 total bench, always exactly 1 GK + 3 outfield for this squad
-- shape); null for starters and the reserve GK - a 15-man squad only ever
-- has exactly one bench GK, so there's nothing to order there.

alter table squad_players add column bench_order integer;
