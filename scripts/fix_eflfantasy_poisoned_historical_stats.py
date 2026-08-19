"""
fix_eflfantasy_poisoned_historical_stats.py
--------------------------------------------
One-time repair for a real production bug caught live 2026-08-19: once EFL
Fantasy's real season kicked off (GW1, 2026-08-14), fantasy.efl.com's
players.json silently stopped returning last-season cumulative stats and
started returning this season's live, round-by-round figures instead -
but import_eflfantasy.py kept writing that straight into the "historical
baseline" row (game_player_stats, season='2025/26', gameweek=0) unchanged
on every refresh, quietly poisoning it for every still-active player (see
import_eflfantasy.py's season_has_kicked_off() docstring for the full
story - that function now stops this from recurring going forward).

This script is the one-time cleanup for the damage already done: DELETEs
the poisoned historical row for every currently-active (non-"eliminated")
EFL Fantasy player, cross-checked directly against the live scraped feed
(eflfantasy_players_raw.json) rather than a DB-side heuristic - so this
only touches rows we can positively confirm were overwritten with live
current-season data. A deleted row isn't a loss: compute_projections.py's
query is a LEFT JOIN (coalesce(...,0) on every stat), so a missing row
already reads as "no historical signal" and correctly falls back to the
position-level prior - exactly the same safe path a genuine zero-PT1
player already takes, just applied honestly instead of trusting a false,
overconfident "1 real appearance."

Run this ONCE, then re-run refresh_all.py --only eflfantasy (or just
compute_projections.py eflfantasy --gameweek N) to see sane scores again.
Safe to re-run - it only ever deletes rows matching the live feed's
current "active" list, and once a row's gone, re-running finds nothing
left to delete for that player.

RUN:
    python3 scripts/fix_eflfantasy_poisoned_historical_stats.py
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
    raw_path = ROOT / "eflfantasy_players_raw.json"
    if not raw_path.exists():
        raise SystemExit(f"{raw_path} not found - run scraper_eflfantasy.py first so this has a live feed to check against.")

    players_data = json.loads(raw_path.read_text(encoding="utf-8"))
    active_external_ids = [str(p["id"]) for p in players_data if p.get("status") != "eliminated"]
    print(f"{len(active_external_ids)} active (non-eliminated) players in the current live feed.")

    conn = psycopg2.connect(os.environ["DATABASE_URL"])
    conn.autocommit = False
    cur = conn.cursor()
    try:
        cur.execute("select id from fantasy_games where slug = 'eflfantasy'")
        row = cur.fetchone()
        if not row:
            raise SystemExit("No fantasy_games row for slug='eflfantasy'.")
        game_id = row[0]

        cur.execute(
            """
            select count(*) from game_player_stats
            where season = '2025/26' and gameweek = 0
              and game_player_id in (
                select gp.id from game_players gp
                where gp.game_id = %s and gp.external_id = any(%s)
              )
            """,
            (game_id, active_external_ids),
        )
        before = cur.fetchone()[0]
        print(f"Poisoned historical rows found for currently-active players: {before}")

        cur.execute(
            """
            delete from game_player_stats
            where season = '2025/26' and gameweek = 0
              and game_player_id in (
                select gp.id from game_players gp
                where gp.game_id = %s and gp.external_id = any(%s)
              )
            """,
            (game_id, active_external_ids),
        )
        print(f"Deleted {cur.rowcount} poisoned row(s).")
        conn.commit()
        print("Committed. Now re-run: python scripts/refresh_all.py --only eflfantasy")
    except Exception:
        conn.rollback()
        raise
    finally:
        cur.close()
        conn.close()


if __name__ == "__main__":
    main()
