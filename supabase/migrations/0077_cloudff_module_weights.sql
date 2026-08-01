-- Cloud FF runs the same v2-decomposed engine as FanTeam/Dream Team
-- (game_scoring_rules seeded by migration 0073) but was never given rows
-- in projection_module_weights - migrations 0063/0065/0076 all seeded
-- only fanteam/dreamteam. resolve_module_weights() therefore returns {}
-- for Cloud FF, and blend_module_rates()'s no-configured-weight fallback
-- (scripts/compute_projections.py) equal-weights every module that
-- computes a non-None rate for a stat - including fantasy_influence,
-- whose weight is a BINDING zero-everywhere constraint (see migration
-- 0076's docstring: "Production influence is not restored by default...
-- until this comparison shows genuine incremental predictive value").
-- Cloud FF was silently violating that constraint in every automated
-- twice-daily recompute since fantasy_influence shipped.
--
-- Fix: seed Cloud FF with the exact same per-position weights fanteam and
-- dreamteam already use (migration 0065's historical_performance/
-- fixture_model/bookmaker_intelligence/recent_form values, migration
-- 0076's fantasy_influence=0) - not new values, just extending the
-- already-decided configuration to the one v2 game that was missed.
insert into projection_module_weights (game_id, position, module, weight)
select fg.id, v.position, v.module, v.weight
from fantasy_games fg
cross join (
  values
    ('GK', 'historical_performance', 0.35), ('GK', 'fixture_model', 0.20), ('GK', 'bookmaker_intelligence', 0.35), ('GK', 'recent_form', 0.10), ('GK', 'fantasy_influence', 0.00),
    ('DEF', 'historical_performance', 0.30), ('DEF', 'fixture_model', 0.20), ('DEF', 'bookmaker_intelligence', 0.30), ('DEF', 'recent_form', 0.10), ('DEF', 'fantasy_influence', 0.00),
    ('MID', 'historical_performance', 0.30), ('MID', 'fixture_model', 0.15), ('MID', 'bookmaker_intelligence', 0.25), ('MID', 'recent_form', 0.15), ('MID', 'fantasy_influence', 0.00),
    ('FWD', 'historical_performance', 0.25), ('FWD', 'fixture_model', 0.10), ('FWD', 'bookmaker_intelligence', 0.30), ('FWD', 'recent_form', 0.15), ('FWD', 'fantasy_influence', 0.00)
) as v(position, module, weight)
where fg.slug = 'cloudff'
on conflict (game_id, position, module) do nothing;
