-- Mary Performance Lab - real adherence + counterfactual grading, closing
-- the loop the user asked for: "was there any transfer/captain change
-- recommended before the deadline that I didn't make - if so what was
-- the gain/loss?" prediction_evaluations already grades transfer/captain
-- predictions against actual points; this adds whether the recommendation
-- was actually followed and, when it wasn't, the real points swing of
-- the choice actually made instead.
--
-- Computed by scripts/evaluate_predictions.py cross-referencing
-- squad_transfers/squad_captain_history (precise, gameweek-scoped logs
-- of every real change ever made) - not the old frontend's read-time
-- (out_player, in_player) match with no gameweek check, which counted a
-- transfer made in a LATER gameweek than recommended as "followed".
--
-- was_followed is null until graded (same gate as the existing
-- evaluation columns - needs actuals to exist for the gameweek first,
-- since "was it followed" and "what did it cost" are graded together).
-- counterfactual_player_id means "whoever was actually in that slot
-- instead" - the player the user really kept (not_followed, no real
-- transfer made) or the real captain if different from Mary's pick.
alter table prediction_evaluations
  add column was_followed boolean,
  add column counterfactual_player_id bigint references game_players(id),
  add column counterfactual_actual_points numeric(6, 2),
  add column counterfactual_gain numeric(6, 2);
