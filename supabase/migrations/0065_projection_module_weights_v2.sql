-- player_role and recent_form (migration 0063) were seeded at weight 0 -
-- deliberate placeholders, since neither estimator existed yet. Both are
-- now real (see compute_projections.py's compute_module_rate_player_role/
-- recent_form) - player_role from real historical team-goal-share data
-- (available today), recent_form from player_gameweek_predictions.actual_*
-- (correctly returns no signal for anyone until a real 2026/27 gameweek
-- is played and graded, but the weight is set now so it activates at its
-- intended strength automatically the moment that data exists, rather
-- than needing another migration later). player_role is deliberately 0
-- for GK - goal/assist involvement share has no real meaning for a
-- goalkeeper's clean-sheet-driven scoring.
update projection_module_weights set weight = v.weight, updated_at = now()
from (
  values
    ('GK', 'historical_performance', 0.35), ('GK', 'fixture_model', 0.20), ('GK', 'bookmaker_intelligence', 0.35),
    ('GK', 'player_role', 0.00), ('GK', 'recent_form', 0.10),
    ('DEF', 'historical_performance', 0.30), ('DEF', 'fixture_model', 0.20), ('DEF', 'bookmaker_intelligence', 0.30),
    ('DEF', 'player_role', 0.10), ('DEF', 'recent_form', 0.10),
    ('MID', 'historical_performance', 0.30), ('MID', 'fixture_model', 0.15), ('MID', 'bookmaker_intelligence', 0.25),
    ('MID', 'player_role', 0.15), ('MID', 'recent_form', 0.15),
    ('FWD', 'historical_performance', 0.25), ('FWD', 'fixture_model', 0.10), ('FWD', 'bookmaker_intelligence', 0.30),
    ('FWD', 'player_role', 0.20), ('FWD', 'recent_form', 0.15)
) as v(position, module, weight)
where projection_module_weights.position = v.position and projection_module_weights.module = v.module;
