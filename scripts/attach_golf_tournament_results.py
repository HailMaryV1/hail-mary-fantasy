"""
attach_golf_tournament_results.py
------------------------------------
Hail Mary Golf, Phase 4 - attaches "what actually happened" onto an
already-frozen golf_tournament_predictions row (migration 0049) once
FanTeam has posted a real points value for that golfer in that
tournament. Unlike football (a separate player_gameweek_results table,
populated by capture_gameweek_actuals.py), golf's actual result already
lives inside golf_tournament_entries.raw - the same jsonb blob
import_fanteam_golf.py/the golf import server action already wrote, whose
`points` field is null pre-tournament and gets populated by FanTeam once
the event concludes. Re-running the weekly importer against a completed
tournament refreshes that jsonb blob with final scores - this script just
reads it, it doesn't scrape anything new itself.

Updates only - never inserts. A result with no matching frozen prediction
row (a golfer added to the pool after the deadline froze, or the capture
script hasn't run yet) is logged as orphaned rather than silently dropped.
Idempotent, always recomputes from golf_tournament_entries.raw - not
locked, matching player_gameweek_predictions' own "actual side is never
covered by locked_at" convention (a later, more-settled scrape - FanTeam
correcting a card/DQ ruling after the fact - can overwrite).

RUN:
    python3 scripts/attach_golf_tournament_results.py
"""

import json
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
            select gte.tournament_id, gte.game_player_id, gte.raw, gtp.expected_points, gtp.id
            from golf_tournament_entries gte
            join golf_tournament_predictions gtp
                on gtp.tournament_id = gte.tournament_id and gtp.game_player_id = gte.game_player_id
            """
        )
        rows = cur.fetchall()

        cur.execute(
            """
            select count(*)
            from golf_tournament_entries gte
            left join golf_tournament_predictions gtp
                on gtp.tournament_id = gte.tournament_id and gtp.game_player_id = gte.game_player_id
            where gtp.id is null and gte.raw->>'points' is not null
            """
        )
        (orphan_candidate_count,) = cur.fetchone()

        attached, skipped_no_result, orphaned = 0, 0, 0
        for tournament_id, game_player_id, raw, expected_points, prediction_id in rows:
            if isinstance(raw, str):
                raw = json.loads(raw)
            actual_points = raw.get("points")
            if actual_points is None:
                skipped_no_result += 1
                continue

            actual_points = float(actual_points)
            points_difference = actual_points - float(expected_points) if expected_points is not None else None

            cur.execute(
                """
                update golf_tournament_predictions
                set actual_points = %s, points_difference = %s, actuals_captured_at = now()
                where id = %s
                """,
                (actual_points, points_difference, prediction_id),
            )
            attached += 1

        # Real orphans (a result exists with no frozen prediction at all) -
        # counted separately from skipped_no_result (a frozen prediction
        # exists but FanTeam hasn't posted a result yet, the normal
        # pre-completion state, not a problem).
        orphaned = orphan_candidate_count

        conn.commit()
        print(
            f"Attached actuals to {attached} prediction row(s); {skipped_no_result} still awaiting a result; "
            f"{orphaned} result(s) had no matching frozen prediction to attach to."
        )
    except Exception:
        conn.rollback()
        raise
    finally:
        cur.close()
        conn.close()


if __name__ == "__main__":
    main()
