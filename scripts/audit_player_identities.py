"""
audit_player_identities.py
-----------------------------
Read-only. Finds real duplicate/split identities in `players` - one real
footballer must map to exactly one players.id, or historical stats,
squad matching, and projections all silently fragment across rows.

Two tiers, deliberately NOT treated the same way:

1. EXACT duplicates - same full_name + team_id + position, byte for
   byte. Zero ambiguity: this can only happen if the same real player
   got inserted twice (a matching-bug artifact, not two different real
   people). Confirmed live: Ethan Ampadu, Evann Guessand, Lamare
   Bogarde, Mats Wieffer each have exactly 2 rows - the newer row of
   each pair has ONLY an inactive game_players row with a synthetic
   "merged-<id>" external_id (not a real FanTeam ID), strongly
   suggesting a past cleanup attempt relabeled the row instead of
   actually merging/deleting it (see merge_player_identities.py).

2. VARIANT candidates - same team + position, DIFFERENT full_name, but
   sharing enough of a name signal (one name contains the other's core
   token) that they're plausibly the same real person under a different
   spelling (e.g. "Tino Livramento" / "Valentino Livramento"). Report
   only - never auto-merged. Two genuinely different real players can
   share a team/position/partial name; only a human (or much stronger
   evidence than this heuristic can provide) should decide these.

For every exact-duplicate group, dumps every real FK reference across
every table that points at players/game_players (found via
information_schema, not hardcoded, so this stays correct as the schema
grows) - the actual basis for the merge script's repoint plan.

RUN:
    python3 scripts/audit_player_identities.py
"""
import io
import os
import sys
from pathlib import Path

import psycopg2
import psycopg2.extras

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "scripts"))
from name_matching import compact, surname_key  # noqa: E402

# Real player names in this data legitimately contain non-ASCII
# characters (Ekitike/"Ekitiké", Odegaard/"Ødegaard", ...) -
# Windows' console codepage can't print those directly. Force UTF-8 on
# stdout rather than let a real, meaningful finding crash the script
# partway through.
sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding="utf-8", errors="replace")


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
    """Every (table, column) pair with a real FK into foreign_table -
    discovered from the schema itself, not hardcoded, so a new table
    added later is automatically covered."""
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


def count_references(cur, table, column, value):
    cur.execute(f'select count(*) as n from "{table}" where "{column}" = %s', (value,))
    return cur.fetchone()["n"]


def find_exact_duplicates(cur):
    cur.execute(
        """
        select full_name, team_id, position, array_agg(id order by id) as ids
        from players
        group by full_name, team_id, position
        having count(*) > 1
        order by full_name
        """
    )
    return cur.fetchall()


def find_variant_candidates(cur):
    """Same team + position, different full_name, but flagged by the
    EXACT same rule import_fanteam_live.py's real candidate search uses
    (live_compact.endswith(surname_key(name))) - not a separate,
    looser heuristic. Using the real rule here means this report
    predicts precisely what a live import would flag as ambiguous,
    rather than a differently-tuned approximation of it. Report only,
    see module docstring."""
    cur.execute("select id, full_name, team_id, position from players where team_id is not null")
    by_team_position = {}
    for r in cur.fetchall():
        by_team_position.setdefault((r["team_id"], r["position"]), []).append(r)

    candidates = []
    seen_pairs = set()
    for group in by_team_position.values():
        if len(group) < 2:
            continue
        for i, a in enumerate(group):
            for b in group[i + 1 :]:
                if a["full_name"] == b["full_name"]:
                    continue  # already caught as an exact duplicate above
                a_compact, b_compact = compact(a["full_name"]), compact(b["full_name"])
                a_surname, b_surname = surname_key(a["full_name"]), surname_key(b["full_name"])
                if (a_surname and a_compact.endswith(a_surname) and b_compact.endswith(a_surname)) or \
                   (b_surname and b_compact.endswith(b_surname) and a_compact.endswith(b_surname)):
                    pair_key = tuple(sorted([a["id"], b["id"]]))
                    if pair_key not in seen_pairs:
                        seen_pairs.add(pair_key)
                        candidates.append((a, b))
    return candidates


def main():
    load_env()
    conn = psycopg2.connect(os.environ["DATABASE_URL"])
    cur = conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor)

    game_player_fks = find_fk_columns(cur, "game_players")
    player_fks = [(t, c) for t, c in find_fk_columns(cur, "players") if t != "game_players"]

    print("=" * 70)
    print("EXACT DUPLICATES (same full_name + team_id + position)")
    print("=" * 70)
    exact = find_exact_duplicates(cur)
    if not exact:
        print("None found.")
    for group in exact:
        print(f"\n{group['full_name']} (team_id={group['team_id']}, position={group['position']}) - ids: {group['ids']}")
        for player_id in group["ids"]:
            cur.execute("select created_at from players where id = %s", (player_id,))
            created_at = cur.fetchone()["created_at"]
            print(f"  players.id={player_id} (created {created_at})")
            for table, column in player_fks:
                n = count_references(cur, table, column, player_id)
                if n:
                    print(f"    {table}.{column}: {n} row(s)")
            cur.execute("select id, game_id, external_id, is_active from game_players where player_id = %s", (player_id,))
            for gp in cur.fetchall():
                cur.execute("select slug from fantasy_games where id = %s", (gp["game_id"],))
                slug = cur.fetchone()["slug"]
                print(f"    game_players.id={gp['id']} (game={slug}, external_id={gp['external_id']!r}, is_active={gp['is_active']})")
                for table, column in game_player_fks:
                    n = count_references(cur, table, column, gp["id"])
                    if n:
                        print(f"      {table}.{column}: {n} row(s)")

    print("\n" + "=" * 70)
    print("VARIANT CANDIDATES (report only - see module docstring, never auto-merged)")
    print("=" * 70)
    variants = find_variant_candidates(cur)
    if not variants:
        print("None found.")
    for a, b in variants:
        print(f"\n{a['full_name']!r} (id={a['id']}) vs {b['full_name']!r} (id={b['id']}) - team_id={a['team_id']}, position={a['position']}")
        for player_id, name in ((a["id"], a["full_name"]), (b["id"], b["full_name"])):
            cur.execute("select id, game_id, external_id, is_active from game_players where player_id = %s", (player_id,))
            rows = cur.fetchall()
            for gp in rows:
                cur.execute("select slug from fantasy_games where id = %s", (gp["game_id"],))
                slug = cur.fetchone()["slug"]
                print(f"  {name} -> game_players.id={gp['id']} (game={slug}, external_id={gp['external_id']!r}, is_active={gp['is_active']})")
            if not rows:
                print(f"  {name} -> no game_players rows at all")

    cur.close()
    conn.close()


if __name__ == "__main__":
    main()
