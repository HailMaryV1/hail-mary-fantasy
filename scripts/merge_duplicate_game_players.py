"""
merge_duplicate_game_players.py
--------------------------------
One-time backfill for a self-inflicted side effect of
merge_player_identities.py's consolidate_post_merge_collisions() step:
when two players.id rows for the same real person got merged (Phase 1,
2026-08-07), and each already had its own game_players row for FanTeam,
that step correctly deactivated the older of the two colliding rows (so
only one is ever "the" live listing) - but, true to its own docstring
("never deletes"), it left the deactivated row's real historical
game_player_stats permanently stranded there, orphaned from the now-live
active row. That active row then has ZERO stats of its own, so
compute_projections.py's historical-shrinkage component has nothing to
shrink from and silently produces a near-zero score for what's often a
real, expensive, good player.

Confirmed live 2026-08-08 - the user's own FanTeam bench: Viktor
Gyokeres, £9.0m, projecting 1.8 pts. His real season total (131.2 pts,
2240 minutes, 14 goals) was sitting on game_players.id=728 (external_id
'4329253', deactivated), completely invisible to id=1141 (external_id
'4700643', the currently-live listing) - a 32-player-wide pattern,
matched exactly against PHASE1_PAIRS in merge_player_identities.py (same
players, same root cause).

Scope: game_id=2 (FanTeam) only. EFL Fantasy has a separate, smaller
handful of duplicate game_players rows (4 pairs, mostly Trialist
placeholder names) that do NOT fit this pattern - both sides already
have their own real stat rows there, so blindly merging risks
conflating two different real trialists. Deliberately left untouched;
needs its own look.

For every (player_id, game_id=2) group with more than one game_players
row, keeps the row with the HIGHEST id as canonical (created most
recently - matches consolidate_post_merge_collisions's own "deactivate
the older one" choice) and, for every other row in the group:
  - moves its game_player_stats rows onto the canonical row (skipping
    any that would collide with a (game_player_id, season, gameweek)
    row the canonical side already has - none observed in this
    project's real data, but handled defensively rather than crashing)
  - does the same for every other table with a per-gameweek unique key
    on game_player_id (fanteam_player_status, player_gameweek_results,
    player_gameweek_predictions)
  - repoints every other FK column pointing at game_players (found
    generically, same approach as merge_player_identities.py's
    find_fk_columns)
  - deletes the now-empty donor row

Dry-run by default - prints exactly what would change; only writes with
--apply. Recompute FanTeam projections after applying - the whole point
is to give the historical-shrinkage component real data to work with
again.

RUN:
    python3 scripts/merge_duplicate_game_players.py            # dry run
    python3 scripts/merge_duplicate_game_players.py --apply
"""
import argparse
import io
import os
import sys
from pathlib import Path

import psycopg2
import psycopg2.extras

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "scripts"))
from activity_log import log_event  # noqa: E402

sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding="utf-8", errors="replace")

GAME_ID_FANTEAM = 2

# Tables with a unique key of the form (game_player_id, <per-gameweek dimension>) -
# repointing has to go row-by-row so a real collision (both donor and
# canonical already have a row for the same gameweek) gets skipped and
# logged, not crashed on.
PER_GAMEWEEK_TABLES = [
    ("game_player_stats", ["season", "gameweek"]),
    ("fanteam_player_status", ["gameweek"]),
    ("player_gameweek_results", ["game_id", "gameweek"]),
    ("player_gameweek_predictions", ["gameweek"]),
    # projections has its own real unique constraint
    # (algorithm_version_id, game_player_id, gameweek) - confirmed live,
    # a blind bulk repoint crashed on the very first group (both donor
    # and canonical already had their own independently-computed row for
    # the same algorithm version + gameweek).
    ("projections", ["algorithm_version_id", "gameweek"]),
]


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


def find_fk_columns(cur, foreign_table):
    cur.execute(
        """
        select tc.table_name, kcu.column_name
        from information_schema.table_constraints tc
        join information_schema.key_column_usage kcu on kcu.constraint_name = tc.constraint_name
        join information_schema.constraint_column_usage ccu on ccu.constraint_name = tc.constraint_name
        where tc.constraint_type = 'FOREIGN KEY' and ccu.table_name = %s
        """,
        (foreign_table,),
    )
    return [(r["table_name"], r["column_name"]) for r in cur.fetchall()]


def find_duplicate_groups(cur, game_id):
    cur.execute(
        """
        select player_id, array_agg(id order by id) as ids
        from game_players
        where game_id = %s and player_id is not null
        group by player_id
        having count(*) > 1
        """,
        (game_id,),
    )
    return cur.fetchall()


def merge_group(cur, player_id, ids, game_player_fks, apply_changes, log):
    canonical_id = ids[-1]
    donor_ids = ids[:-1]

    cur.execute("select full_name from players where id = %s", (player_id,))
    name = cur.fetchone()["full_name"]
    cur.execute("select id, external_id, price, is_active from game_players where id = any(%s) order by id", (ids,))
    rows = {r["id"]: r for r in cur.fetchall()}

    log(f"\n{name} (player_id={player_id})")
    log(f"  canonical: game_players.id={canonical_id} (external_id={rows[canonical_id]['external_id']!r}, "
        f"price={rows[canonical_id]['price']}, active={rows[canonical_id]['is_active']})")

    for donor_id in donor_ids:
        d = rows[donor_id]
        log(f"  donor:     game_players.id={donor_id} (external_id={d['external_id']!r}, price={d['price']}, active={d['is_active']})")

        for table, dims in PER_GAMEWEEK_TABLES:
            cols = ", ".join(dims)
            cur.execute(f'select id, {cols} from "{table}" where game_player_id = %s', (donor_id,))
            donor_rows = cur.fetchall()
            if not donor_rows:
                continue
            for dr in donor_rows:
                where_clause = " and ".join(f'"{c}" = %s' for c in dims)
                cur.execute(
                    f'select 1 from "{table}" where game_player_id = %s and {where_clause}',
                    (canonical_id, *[dr[c] for c in dims]),
                )
                collides = cur.fetchone() is not None
                dim_desc = ", ".join(f"{c}={dr[c]}" for c in dims)
                if collides:
                    log(f"    [SKIP] {table} row id={dr['id']} ({dim_desc}) - canonical already has one, leaving donor row in place")
                    continue
                log(f"    [MOVE] {table} row id={dr['id']} ({dim_desc}): game_player_id {donor_id} -> {canonical_id}")
                if apply_changes:
                    cur.execute(f'update "{table}" set game_player_id = %s where id = %s', (canonical_id, dr["id"]))

        skip_tables = {t for t, _ in PER_GAMEWEEK_TABLES}
        for table, column in game_player_fks:
            if table in skip_tables:
                continue
            cur.execute(f'select count(*) as n from "{table}" where "{column}" = %s', (donor_id,))
            n = cur.fetchone()["n"]
            if n:
                log(f"  [REPOINT] {table}.{column}: {n} row(s) {donor_id} -> {canonical_id}")
                if apply_changes:
                    cur.execute(f'update "{table}" set "{column}" = %s where "{column}" = %s', (canonical_id, donor_id))

        # Anything left on the donor row after the moves/repoints above
        # (e.g. a per-gameweek row that collided and was deliberately
        # left in place) blocks the delete - report rather than force it.
        # Has to check every table that can still hold an FK to this row,
        # not just game_player_stats - in --apply mode that table is
        # already empty by this point (just moved above), but the
        # per-gameweek tables that hit a collision and were SKIPPED are
        # exactly the ones still pointing here, and every other FK table
        # was already unconditionally repointed above regardless.
        leftover_tables = [t for t, _ in PER_GAMEWEEK_TABLES if t != "game_player_stats"]
        leftover = 0
        leftover_detail = []
        for table in ["game_player_stats", *leftover_tables]:
            cur.execute(f'select count(*) as n from "{table}" where game_player_id = %s', (donor_id,))
            n = cur.fetchone()["n"]
            if n:
                leftover += n
                leftover_detail.append(f"{n} in {table}")
        if leftover:
            log(f"  [KEEP] game_players.id={donor_id} not deleted - {', '.join(leftover_detail)} still reference it after collision skips")
            continue

        log(f"  [DELETE] game_players.id={donor_id}")
        if apply_changes:
            cur.execute("delete from game_players where id = %s", (donor_id,))
            log_event(
                cur, "player_identity_merged",
                f"Merged stranded FanTeam game_players row for {name!r} (id={donor_id}) into the live listing (id={canonical_id})",
                game_id=GAME_ID_FANTEAM,
                details={"player_id": player_id, "canonical_game_player_id": canonical_id, "donor_game_player_id": donor_id},
            )


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--apply", action="store_true")
    args = parser.parse_args()

    load_env()
    conn = psycopg2.connect(os.environ["DATABASE_URL"], cursor_factory=psycopg2.extras.RealDictCursor)
    cur = conn.cursor()

    def log(msg):
        print(msg)

    log(f"{'APPLYING' if args.apply else 'DRY RUN'} - merge_duplicate_game_players.py (FanTeam only)")

    game_player_fks = find_fk_columns(cur, "game_players")
    groups = find_duplicate_groups(cur, GAME_ID_FANTEAM)
    log(f"\nFound {len(groups)} duplicate (player_id, game_id=fanteam) groups.\n")

    for g in groups:
        merge_group(cur, g["player_id"], g["ids"], game_player_fks, args.apply, log)

    if args.apply:
        conn.commit()
        log("\nCommitted.")
    else:
        conn.rollback()
        log("\nDry run only - no changes written. Re-run with --apply to write.")

    cur.close()
    conn.close()


if __name__ == "__main__":
    main()
