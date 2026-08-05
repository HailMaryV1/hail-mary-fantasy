"""
evaluate_predictions.py
-------------------------
Mary Performance Lab, Part 2 - grades stored predictions (from Ask Mary,
frontend/src/app/ask-mary/actions.ts) against real results once they
exist in player_gameweek_results (scripts/capture_gameweek_actuals.py).

Only grades what's actually gradeable:
  - kind='transfer': needs actual points for BOTH the out and in player
    for that gameweek.
  - kind='captain': needs actual points for BOTH the captain and
    vice-captain for that gameweek.
  - kind='hold': not graded in this phase - see migration
    0035_prediction_evaluations.sql's docstring (would need re-deriving
    the full candidate set as of that past gameweek).

A prediction whose gameweek hasn't completed yet (no matching
player_gameweek_results rows) is simply left alone - re-run this script
after every gameweek closes and it picks up whatever's newly gradeable.
Never re-evaluates a prediction that already has a row (one evaluation
per prediction, unique on prediction_id) - re-running this script is
otherwise a no-op for already-graded predictions.

error_attribution is intentionally limited to what's inferable from an
aggregate points number (see the migration's docstring for why) - not
the full injury/red-card/penalty vocabulary from the original feature
spec, which needs match-event data this project doesn't have.

Migration 0085 added real adherence + counterfactual grading, closing
the loop the user asked for directly: "was there any transfer/captain
change recommended before the deadline that I didn't make - if so what
was the gain/loss?" For each gradeable transfer/captain prediction, this
now cross-references squad_transfers/squad_captain_history (precise,
gameweek-scoped logs of every real change ever made) to determine
was_followed, and when it wasn't, a counterfactual_gain - the real
points swing of the choice actually made vs Mary's recommendation.
Positive counterfactual_gain = the recommendation would have scored
more than what the user actually did; negative = the user's own choice
outscored it. Both branches (held entirely / made a different move)
reduce to the same formula: Mary's recommended player's real points
minus whatever the user actually ended up with in that slot.

RUN:
    python3 scripts/evaluate_predictions.py
"""

import os
from pathlib import Path

import psycopg2

ROOT = Path(__file__).resolve().parent.parent

# Within this many points of the prediction, call it "as expected" rather
# than over/underperformed - same order of magnitude as the 0.5-point
# score-change threshold used elsewhere (activity_log, watchlistAlerts.ts),
# scaled up since this is comparing a full gameweek's actual outcome
# rather than one recomputed projection.
AS_EXPECTED_THRESHOLD = 1.5


def load_env():
    env_path = ROOT / ".env"
    if not env_path.exists():
        return  # CI sets real env vars directly - no .env file there.
    for line in env_path.read_text().splitlines():
        line = line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, _, value = line.partition("=")
        os.environ.setdefault(key.strip(), value.strip())


def fetch_actual(cur, game_id, game_player_id, gameweek):
    if game_player_id is None:
        return None, None
    cur.execute(
        "select actual_points, actual_minutes from player_gameweek_results where game_id = %s and game_player_id = %s and gameweek = %s",
        (game_id, game_player_id, gameweek),
    )
    row = cur.fetchone()
    if row is None:
        return None, None
    return row[0], row[1]


def classify_transfer(expected_gain, actual_gain, in_minutes, risk):
    prediction_error = float(expected_gain) - float(actual_gain)
    if in_minutes == 0 and risk == "low":
        return [prediction_error, ["unexpected_unavailability"]]
    if abs(prediction_error) <= AS_EXPECTED_THRESHOLD:
        return [prediction_error, ["as_expected"]]
    if prediction_error < 0:
        return [prediction_error, ["overperformed_expectation"]]
    return [prediction_error, ["underperformed_expectation"]]


def fetch_real_transfer_in(cur, squad_id, gameweek, out_id):
    """The game_player_id actually bought in to replace out_id this
    gameweek, if a matching squad_transfers row exists - None if the
    user held the original player instead."""
    cur.execute(
        "select in_game_player_id from squad_transfers where squad_id = %s and gameweek = %s and out_game_player_id = %s order by id desc limit 1",
        (squad_id, gameweek, out_id),
    )
    row = cur.fetchone()
    return row[0] if row else None


def fetch_real_captain(cur, squad_id, gameweek):
    """The captain actually in effect for this gameweek - the most
    recent squad_captain_history row at or before it (captain changes
    are logged only when made, not once per gameweek - see
    squad_captain_history's own writer in dreamteam/actions.ts/
    squads/actions.ts)."""
    cur.execute(
        "select captain_game_player_id from squad_captain_history where squad_id = %s and gameweek <= %s order by gameweek desc, id desc limit 1",
        (squad_id, gameweek),
    )
    row = cur.fetchone()
    return row[0] if row else None


def transfer_adherence(cur, game_id, squad_id, gameweek, predicted_out_id, predicted_in_id, predicted_in_points):
    """Returns (was_followed, counterfactual_player_id, counterfactual_actual_points, counterfactual_gain)."""
    real_in_id = fetch_real_transfer_in(cur, squad_id, gameweek, predicted_out_id)

    if real_in_id == predicted_in_id:
        return True, None, None, None

    if real_in_id is None:
        # Held the original player - no real transfer for this slot at all.
        counterfactual_id = predicted_out_id
        counterfactual_points, _ = fetch_actual(cur, game_id, predicted_out_id, gameweek)
    else:
        # Made a different move than the one recommended.
        counterfactual_id = real_in_id
        counterfactual_points, _ = fetch_actual(cur, game_id, real_in_id, gameweek)

    if counterfactual_points is None:
        # The player actually kept/bought has no actual-points row yet for
        # this gameweek (e.g. hasn't played, or a data gap) - can't grade
        # the counterfactual honestly without it.
        return False, counterfactual_id, None, None

    counterfactual_gain = float(predicted_in_points) - float(counterfactual_points)
    return False, counterfactual_id, counterfactual_points, counterfactual_gain


def captain_adherence(cur, game_id, squad_id, gameweek, predicted_captain_id, predicted_captain_points):
    real_captain_id = fetch_real_captain(cur, squad_id, gameweek)

    if real_captain_id is None or real_captain_id == predicted_captain_id:
        # No logged captain change at all yet is treated as "followed" -
        # squad_captain_history only exists from migration 0036 onward, so
        # a squad with no history rows predates it and there's no real
        # signal to grade adherence against.
        return True, None, None, None

    counterfactual_points, _ = fetch_actual(cur, game_id, real_captain_id, gameweek)
    if counterfactual_points is None:
        return False, real_captain_id, None, None

    counterfactual_gain = float(predicted_captain_points) - float(counterfactual_points)
    return False, real_captain_id, counterfactual_points, counterfactual_gain


def main():
    load_env()
    conn = psycopg2.connect(os.environ["DATABASE_URL"])
    conn.autocommit = False
    cur = conn.cursor()

    try:
        cur.execute(
            """
            select p.id, p.kind, p.game_id, p.squad_id, p.gameweek, p.out_game_player_id, p.in_game_player_id,
                   p.captain_game_player_id, p.vice_captain_game_player_id, p.expected_gain, p.risk
            from predictions p
            left join prediction_evaluations pe on pe.prediction_id = p.id
            where pe.id is null and p.gameweek is not null and p.kind in ('transfer', 'captain')
            """
        )
        pending = cur.fetchall()

        graded, not_ready = 0, 0
        for pred_id, kind, game_id, squad_id, gameweek, out_id, in_id, captain_id, vice_id, expected_gain, risk in pending:
            if kind == "transfer":
                out_points, _ = fetch_actual(cur, game_id, out_id, gameweek)
                in_points, in_minutes = fetch_actual(cur, game_id, in_id, gameweek)
                if out_points is None or in_points is None:
                    not_ready += 1
                    continue
                actual_gain = float(in_points) - float(out_points)
                prediction_error, attribution = classify_transfer(expected_gain or 0, actual_gain, in_minutes, risk)
                was_followed, cf_id, cf_points, cf_gain = transfer_adherence(cur, game_id, squad_id, gameweek, out_id, in_id, in_points)
                cur.execute(
                    """
                    insert into prediction_evaluations
                        (prediction_id, actual_points_out, actual_points_in, actual_gain, prediction_error,
                         transfer_success, error_attribution, was_followed, counterfactual_player_id,
                         counterfactual_actual_points, counterfactual_gain)
                    values (%s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s)
                    """,
                    (pred_id, out_points, in_points, actual_gain, prediction_error, actual_gain > 0, attribution, was_followed, cf_id, cf_points, cf_gain),
                )
                graded += 1

            elif kind == "captain":
                captain_points, _ = fetch_actual(cur, game_id, captain_id, gameweek)
                vice_points, _ = fetch_actual(cur, game_id, vice_id, gameweek)
                if captain_points is None or vice_points is None:
                    not_ready += 1
                    continue
                was_followed, cf_id, cf_points, cf_gain = captain_adherence(cur, game_id, squad_id, gameweek, captain_id, captain_points)
                cur.execute(
                    """
                    insert into prediction_evaluations
                        (prediction_id, captain_actual_points, vice_captain_actual_points, captain_success,
                         was_followed, counterfactual_player_id, counterfactual_actual_points, counterfactual_gain)
                    values (%s, %s, %s, %s, %s, %s, %s, %s)
                    """,
                    (pred_id, captain_points, vice_points, float(captain_points) >= float(vice_points), was_followed, cf_id, cf_points, cf_gain),
                )
                graded += 1

        conn.commit()
        print(f"Graded {graded} prediction(s); {not_ready} still awaiting actual results for their gameweek.")
    except Exception:
        conn.rollback()
        raise
    finally:
        cur.close()
        conn.close()


if __name__ == "__main__":
    main()
