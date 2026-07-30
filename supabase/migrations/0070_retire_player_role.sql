-- Retires Player Role V1 from the projection engine, completing the arc
-- started by migration 0067 (weight set to 0 after scripts/
-- audit_player_role.py found a one-directional, elite-attacker-concentrated
-- suppression pattern). A later architectural review proved WHY that
-- pattern existed: compute_module_rate_player_role's formula
-- (share x team_per90, where share = player_total/team_total and
-- team_per90 = team_total/team_games90) algebraically cancels team_total,
-- reducing exactly to player_total/team_games90 - a scaled-down duplicate
-- of Historical Performance's own rate, not an independent "role" signal.
-- Verified against the full live player pool: reintroducing it at its
-- original weight would move 0% of outfield players up and ~93% down,
-- concentrated on each team's best scorer (see the retirement plan's
-- impact assessment for the full figures).
--
-- Player Role's configured weight was already 0 for every position in
-- both games, so this migration changes no live score - it removes the 8
-- now-orphaned weight rows (compute_projections.py no longer computes a
-- player_role rate for blend_module_rates to look a weight up for) and
-- narrows the module CHECK constraint to the 4 modules that remain:
-- historical_performance, fixture_model, bookmaker_intelligence,
-- recent_form.
delete from projection_module_weights where module = 'player_role';

alter table projection_module_weights drop constraint projection_module_weights_module_check;

alter table projection_module_weights add constraint projection_module_weights_module_check
  check (module in ('historical_performance', 'fixture_model', 'bookmaker_intelligence', 'recent_form'));
