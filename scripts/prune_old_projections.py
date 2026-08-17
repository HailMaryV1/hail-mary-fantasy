"""
prune_old_projections.py
--------------------------
Deletes superseded rows from `projections` - every stat-tuning change
(a weights dict edit in compute_projections.py) mints a new
algorithm_version via get_or_create_algorithm_version(), and every
subsequent recompute inserts a FRESH row for every (game_player_id,
gameweek) rather than overwriting the old one (the upsert's conflict
target is (algorithm_version_id, game_player_id, gameweek) - a new
version_id can never match an existing row, so nothing old ever gets
touched, let alone removed). Confirmed live 2026-08-17: 28 revisions of
the "v2-decomposed" family alone, 86,691 total rows, ~168MB - all but
the latest revision's worth is pure dead weight, since every real
consumer (player_projection_summary view, capture_gameweek_predictions.py,
capture_golf_predictions.py, explain_player_projection.py,
compute_projections.py's own read-back) already only ever selects the
single most-recently-created row per (game_player_id, gameweek) - see
each of their own `order by created_at desc` / lateral-join patterns.
None of them read older rows on purpose, so keeping them serves no
consumer at all.

This is deliberately NOT where "compare an old prediction against what
actually happened" lives - that's player_gameweek_predictions/
golf_tournament_predictions (migration 0044/0049), a permanent FROZEN
snapshot captured at deadline specifically for Performance Lab/Hail Mary
Form grading, entirely separate from this table and untouched by this
script. `projections` itself is a live, mutable "what does the engine
say right now" cache with no archival purpose of its own - the real
archive already exists elsewhere.

Different games interleave onto the SAME algorithm_version revision
counter within a family (e.g. revision 13 might be cloudff-only while
revision 14 is fanteam-only - confirmed live) - so "keep the single
globally-highest revision" would wrongly delete other games' current
data. This instead keeps, independently for every (game_player_id,
gameweek) pair, only the row with the latest created_at - exactly
mirroring what player_projection_summary's own lateral join already
selects, so nothing a real consumer would ever see changes.

Safe to run repeatedly (idempotent - a second run finds nothing left to
prune) and safe to run on a schedule (see refresh_all.py's run_wrapup),
since it only ever removes rows that no read path has used since the
moment a newer one was inserted for that exact player+gameweek.

RUN:
    python3 scripts/prune_old_projections.py
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
        cur.execute("select count(*) from projections")
        before_count = cur.fetchone()[0]
        cur.execute("select pg_size_pretty(pg_total_relation_size('projections'))")
        before_size = cur.fetchone()[0]

        cur.execute(
            """
            delete from projections
            where id not in (
                select distinct on (game_player_id, gameweek) id
                from projections
                order by game_player_id, gameweek, created_at desc
            )
            """
        )
        deleted = cur.rowcount
        conn.commit()

        cur.execute("select count(*) from projections")
        after_count = cur.fetchone()[0]
        conn.commit()  # psycopg2 opens a new implicit transaction on that select - close it before flipping autocommit

        # VACUUM can't run inside a transaction block - needs autocommit,
        # and only after the delete above is already committed.
        conn.autocommit = True
        cur.execute("vacuum projections")  # reclaims disk space immediately rather than waiting for autovacuum
        conn.autocommit = False

        cur.execute("select pg_size_pretty(pg_total_relation_size('projections'))")
        after_size = cur.fetchone()[0]

        print(f"Deleted {deleted} superseded projection row(s).")
        print(f"Row count: {before_count} -> {after_count}")
        print(f"Table size: {before_size} -> {after_size}")
    except Exception:
        conn.rollback()
        raise
    finally:
        cur.close()
        conn.close()


if __name__ == "__main__":
    main()
