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


def main():
    load_env()
    conn = psycopg2.connect(os.environ["DATABASE_URL"])
    conn.autocommit = False
    cur = conn.cursor()

    try:
        cur.execute(
            """
            select p.id, p.kind, p.game_id, p.gameweek, p.out_game_player_id, p.in_game_player_id,
                   p.captain_game_player_id, p.vice_captain_game_player_id, p.expected_gain, p.risk
            from predictions p
            left join prediction_evaluations pe on pe.prediction_id = p.id
            where pe.id is null and p.gameweek is not null and p.kind in ('transfer', 'captain')
            """
        )
        pending = cur.fetchall()

        graded, not_ready = 0, 0
        for pred_id, kind, game_id, gameweek, out_id, in_id, captain_id, vice_id, expected_gain, risk in pending:
            if kind == "transfer":
                out_points, _ = fetch_actual(cur, game_id, out_id, gameweek)
                in_points, in_minutes = fetch_actual(cur, game_id, in_id, gameweek)
                if out_points is None or in_points is None:
                    not_ready += 1
                    continue
                actual_gain = float(in_points) - float(out_points)
                prediction_error, attribution = classify_transfer(expected_gain or 0, actual_gain, in_minutes, risk)
                cur.execute(
                    """
                    insert into prediction_evaluations
                        (prediction_id, actual_points_out, actual_points_in, actual_gain, prediction_error,
                         transfer_success, error_attribution)
                    values (%s, %s, %s, %s, %s, %s, %s)
                    """,
                    (pred_id, out_points, in_points, actual_gain, prediction_error, actual_gain > 0, attribution),
                )
                graded += 1

            elif kind == "captain":
                captain_points, _ = fetch_actual(cur, game_id, captain_id, gameweek)
                vice_points, _ = fetch_actual(cur, game_id, vice_id, gameweek)
                if captain_points is None or vice_points is None:
                    not_ready += 1
                    continue
                cur.execute(
                    """
                    insert into prediction_evaluations
                        (prediction_id, captain_actual_points, vice_captain_actual_points, captain_success)
                    values (%s, %s, %s, %s)
                    """,
                    (pred_id, captain_points, vice_points, float(captain_points) >= float(vice_points)),
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
