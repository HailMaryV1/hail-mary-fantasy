"""
merge_joao_pedro_dreamteam.py
-------------------------------
One-off merge for a Dream Team-specific clone of Joao Pedro (Chelsea),
found 2026-08-17: players.id=4986 ("Jo?o Pedro Junqueira de Jesus" -
his real full name, but with a corrupted/mojibake accent character,
confirming a text-encoding bug somewhere in scraper_dreamteam.py's/
import_dreamteam.py's handling of this specific name) has only ONE
game_players row (dreamteam, price=5.00) and thin historical stats -
the same "Dream Team's live API returns a fuller name variant the
matching logic doesn't recognise as the existing player" root cause
merge_player_identities.py's own docstring already documents for
Ampadu/Guessand/Bogarde/Wieffer, just not caught for this one.

Canonical is players.id=379 ("Joao Pedro") - already active on fanteam
(price=9.00) AND cloudff (price=10.50) with real historical stats,
matching merge_player_identities.py's own "canonical is always the row
with a real dreamteam and/or cloudff anchor" rule.

Reuses that file's own merge_pair()/consolidate_post_merge_collisions()
functions rather than duplicating the FK-discovery/repoint/dry-run
logic.

RUN:
    python3 scripts/merge_joao_pedro_dreamteam.py            # dry run
    python3 scripts/merge_joao_pedro_dreamteam.py --apply
"""
import argparse
import os
import sys
from pathlib import Path

import psycopg2
import psycopg2.extras

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "scripts"))
from merge_player_identities import find_fk_columns, merge_pair, consolidate_post_merge_collisions  # noqa: E402

PAIRS = [
    (379, 4986, "Joao Pedro - Dream Team-only clone under his full name with a corrupted accent character"),
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


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--apply", action="store_true")
    args = parser.parse_args()

    load_env()
    conn = psycopg2.connect(os.environ["DATABASE_URL"])
    conn.autocommit = False
    cur = conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor)

    def log(msg):
        print(msg)

    try:
        game_player_fks = find_fk_columns(cur, "game_players")
        player_fks = [(t, c) for t, c in find_fk_columns(cur, "players") if t != "game_players"]

        log(f"{'APPLYING' if args.apply else 'DRY RUN'} - {len(PAIRS)} pair(s)")
        for canonical_id, duplicate_id, reason in PAIRS:
            merge_pair(cur, canonical_id, duplicate_id, reason, game_player_fks, player_fks, args.apply, log)

        consolidate_post_merge_collisions(cur, PAIRS, args.apply, log)

        if args.apply:
            conn.commit()
            log("\nCommitted.")
        else:
            conn.rollback()
            log("\nDry run only - nothing written. Re-run with --apply to execute.")
    except Exception:
        conn.rollback()
        raise
    finally:
        cur.close()
        conn.close()


if __name__ == "__main__":
    main()
