-- Adds "fantasy_influence" as the 5th modular projection engine module -
-- the renamed "Player Role V2" (see the "Player Role V2 - Design
-- Proposal" artifact, 2026-07-30). Replaces Player Role V1, retired by
-- migration 0070 after an audit found its formula (share x team_per90)
-- algebraically collapsed to a scaled duplicate of Historical
-- Performance's own rate - mathematically bounded at the team average by
-- construction, which silently suppressed elite attackers who outscore
-- their own teammates. Fantasy Influence's structural fix is a RATIO to
-- the position average instead (unbounded - reuses the same technique
-- fixture_stat_factor already uses elsewhere in compute_projections.py),
-- computed via leave-one-out blending of goal/assist/shot-on-target
-- involvement indices so no stat's scaling multiplier is ever derived
-- from that same stat's own rate.
--
-- Seeded at weight 0 for EVERY position, both games - deliberately, not
-- a placeholder. The design artifact is explicit and binding: "Production
-- influence is not restored by default... until this comparison shows
-- genuine incremental predictive value" (Performance Lab, once real
-- 2026/27 results exist). This migration only makes the module
-- computable and visible on Engine Validation - it changes no live score.
alter table projection_module_weights drop constraint projection_module_weights_module_check;

alter table projection_module_weights add constraint projection_module_weights_module_check
  check (module in ('historical_performance', 'fixture_model', 'bookmaker_intelligence', 'recent_form', 'fantasy_influence'));

insert into projection_module_weights (game_id, position, module, weight)
select fg.id, pos.position, 'fantasy_influence', 0
from fantasy_games fg
cross join (values ('GK'), ('DEF'), ('MID'), ('FWD')) as pos(position)
where fg.slug in ('fanteam', 'dreamteam')
on conflict (game_id, position, module) do nothing;
