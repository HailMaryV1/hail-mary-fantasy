"""
attach_gameweek_results.py
-----------------------------
Hail Mary Form System, Part 1 - attaches "what actually happened" onto an
already-frozen player_gameweek_predictions row (migration 0044) once
player_gameweek_results has data for that gameweek
(scripts/capture_gameweek_actuals.py). Updates only - never inserts a new
player_gameweek_predictions row; a result arriving with no prior frozen
prediction for that player+gameweek is logged as orphaned rather than
silently dropped or half-populated (that can happen if actuals get
captured for a player whose deadline-time projection was somehow missing,
e.g. a data gap - worth knowing about, not worth pretending never happens).

Only actual_minutes/actual_points are populatable today - see migration
0044's docstring for why actual_goals/assists/clean_sheets/cards stay
null (no data source provides them yet).

Computes two diffs once both sides exist:
  points_difference = actual_points - expected_points
  minutes_adjusted_difference = actual_points -
      (expected_points_per_90 * actual_minutes / 90)
Isolates minutes-model error from genuine performance difference: if a
player was projected at their normal per-90 rate but played far fewer
minutes than expected, points_difference alone looks like a big miss even
though the model's rate was fine - it just mispredicted minutes.
minutes_adjusted_difference recomputes expected points AT the actual
minutes played, using the model's own per-90 rate, so a genuine per-90
miss and a minutes-prediction miss can be told apart. The Hail Mary Form
badge (frontend/src/lib/hailMaryForm.ts) is driven by points_difference,
not this one - see that file's docstring for why.

Not locked/frozen - a later, more-settled scrape of
player_gameweek_results can correct these, same "a later, more-settled
scrape can overwrite" philosophy player_gameweek_results itself already
documents. Idempotent - always recomputes from current
player_gameweek_results, safe to re-run.

RUN:
    python3 scripts/attach_gameweek_results.py
"""

import os
from pathlib import Path

import psycopg2

ROOT = Path(__file__).resolve().parent.parent


def load_env():
    env_path = ROOT / ".env"
    if not env_path.exists():
        return
    for line in env_path.read_text().splitlines():
        line = line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, _, value = line.partition("=")
        os.environ.setdefault(key.strip(), value.strip())


def main():
    load_env()
    conn = psycopg2.connect(os.environ["DATABASE_URL"])
    conn.autocommit = False
    cur = conn.cursor()

    try:
        cur.execute(
            """
            select r.game_player_id, r.gameweek, r.actual_minutes, r.actual_points,
                   p.expected_points, p.expected_points_per_90
            from player_gameweek_results r
            join player_gameweek_predictions p
                on p.game_player_id = r.game_player_id and p.gameweek = r.gameweek
            where r.actual_points is not null
            """
        )
        rows = cur.fetchall()

        cur.execute(
            """
            select count(*)
            from player_gameweek_results r
            left join player_gameweek_predictions p
                on p.game_player_id = r.game_player_id and p.gameweek = r.gameweek
            where r.actual_points is not null and p.id is null
            """
        )
        (orphaned,) = cur.fetchone()

        attached = 0
        for game_player_id, gameweek, actual_minutes, actual_points, expected_points, expected_pp90 in rows:
            points_difference = None
            if expected_points is not None:
                points_difference = float(actual_points) - float(expected_points)

            minutes_adjusted_difference = None
            if expected_pp90 is not None and actual_minutes is not None:
                minutes_adjusted_difference = float(actual_points) - (float(expected_pp90) * actual_minutes / 90.0)

            cur.execute(
                """
                update player_gameweek_predictions
                set actual_minutes = %s, actual_points = %s,
                    points_difference = %s, minutes_adjusted_difference = %s,
                    actuals_captured_at = now()
                where game_player_id = %s and gameweek = %s
                """,
                (actual_minutes, actual_points, points_difference, minutes_adjusted_difference, game_player_id, gameweek),
            )
            attached += 1

        conn.commit()
        print(f"Attached actuals to {attached} prediction row(s); {orphaned} result(s) had no matching frozen prediction to attach to.")
    except Exception:
        conn.rollback()
        raise
    finally:
        cur.close()
        conn.close()


if __name__ == "__main__":
    main()
