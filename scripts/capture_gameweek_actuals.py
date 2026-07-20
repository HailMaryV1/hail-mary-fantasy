"""
capture_gameweek_actuals.py
----------------------------
Mary Performance Lab, Part 2 - captures the "what actually happened" data
that nothing in this pipeline retains today.

fanteam_player_status.total_points/last_points cannot serve this role:
import_fanteam_live.py upserts it per (game_player_id, gameweek) for
whichever gameweek is currently EDITABLE (upcoming), so once that
gameweek closes and the editable round advances, the previous gameweek's
values are gone - there is no history there (see migration 0029, and
0034_player_gameweek_results.sql's docstring).

This script instead reads the CURRENT fanteam_player_status row for each
player - captured moments ago by import_fanteam_live.py - and treats its
`last_points`/`minutes` fields as the ACTUAL result of gameweek N-1,
where N is that row's own (editable) gameweek. Writes into
player_gameweek_results, keyed by (game_id, game_player_id, N-1) so a
later, more-settled scrape (e.g. after a post-match points correction)
safely overwrites an earlier one for the same gameweek instead of
duplicating it.

UNCONFIRMED, same as compute_projections.py's lineup/status mapping:
whether `lastPoints` really means "points scored in the previous
gameweek" can't be verified until a real gameweek actually completes -
there is no season-started data yet (2026-07-20). Sanity-check the
first real values once GW1 finishes.

Skips gameweek 1 (N-1 = 0 is meaningless - nothing has been played yet).

RUN:
    python3 scripts/capture_gameweek_actuals.py
"""

import os
from pathlib import Path

import psycopg2

ROOT = Path(__file__).resolve().parent.parent


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


def main():
    load_env()
    conn = psycopg2.connect(os.environ["DATABASE_URL"])
    conn.autocommit = False
    cur = conn.cursor()

    try:
        cur.execute(
            """
            select gp.game_id, s.game_player_id, s.gameweek, s.last_points, s.minutes
            from fanteam_player_status s
            join game_players gp on gp.id = s.game_player_id
            where s.gameweek >= 2
            """
        )
        rows = cur.fetchall()

        written = 0
        for game_id, game_player_id, gameweek, last_points, minutes in rows:
            actual_gameweek = gameweek - 1
            cur.execute(
                """
                insert into player_gameweek_results (game_id, game_player_id, gameweek, actual_points, actual_minutes, captured_at)
                values (%s, %s, %s, %s, %s, now())
                on conflict (game_id, game_player_id, gameweek) do update
                    set actual_points = excluded.actual_points, actual_minutes = excluded.actual_minutes,
                        captured_at = excluded.captured_at
                """,
                (game_id, game_player_id, actual_gameweek, last_points, minutes),
            )
            written += 1

        conn.commit()
        print(f"Captured {written} gameweek-actual rows from {len(rows)} current player-status records.")
    except Exception:
        conn.rollback()
        raise
    finally:
        cur.close()
        conn.close()


if __name__ == "__main__":
    main()
