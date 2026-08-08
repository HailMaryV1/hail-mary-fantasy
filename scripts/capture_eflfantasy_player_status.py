"""
capture_eflfantasy_player_status.py
------------------------------------
EFL Fantasy's own live availability capture - deliberately separate from
FanTeam's pipeline (import_fanteam_live.py / fanteam_player_status).
Confirmed live 2026-08-08: fantasy.efl.com's own players.json feed
already carries a real "status" field (playing/injured/suspended/
eliminated) plus real injuryDetails/suspensionDetails text, but nothing
in this project ever captured playing/injured/suspended anywhere - only
"eliminated" gets used (import_eflfantasy.py, to deactivate a player
outright). A real player showing "injured" on the live site (Jack
Tucker, confirmed live) kept getting scored and recommended here as if
fully fit.

Deliberately lightweight - does NOT re-run the full player/team/fixture/
historical-stats import (that's import_eflfantasy.py's job, on its own
slower cadence). This script only re-fetches players.json and writes
each active player's current status into eflfantasy_player_status
(migration 0104) - cheap enough to run several times a day so injuries/
suspensions/returns get picked up same-day, not just whenever the next
full import happens to run.

compute_projections.py's compute_opportunity() already treats a bare
"injured"/"suspended" status as a hard out (OPPORTUNITY_HARD_OUT_STATUSES)
for any game whose fetch_live_status dispatches to it - no engine
changes needed beyond wiring this table in (see fetch_eflfantasy_player_
status). Re-run compute_projections.py for eflfantasy after this to
apply a newly-captured injury to the projections.

RUN:
    python3 scripts/capture_eflfantasy_player_status.py
"""
import gzip
import json
import os
import subprocess
import sys
import urllib.request
from pathlib import Path

import psycopg2
import psycopg2.extras

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "scripts"))

PLAYERS_URL = "https://fantasy.efl.com/json/fantasy/players.json"


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


def fetch_players():
    # Same gzip-magic-bytes handling as scraper_eflfantasy.py - the feed
    # gzips regardless of Accept-Encoding and doesn't reliably set
    # Content-Encoding to say so.
    req = urllib.request.Request(PLAYERS_URL, headers={"User-Agent": "Mozilla/5.0"})
    with urllib.request.urlopen(req, timeout=30) as resp:
        raw = resp.read()
    if raw[:2] == b"\x1f\x8b":
        raw = gzip.decompress(raw)
    return json.loads(raw)


def resolve_current_gameweek(cur, game_id):
    """Earliest gameweek that still has at least one fixture in the
    future - "in progress or upcoming," the same practical definition
    fetch_deadlines()-style capture scripts elsewhere in this project
    use. None if the calendar has no fixtures left at all (season over,
    or not yet imported)."""
    cur.execute(
        """
        select gfg.gameweek
        from game_fixture_gameweeks gfg
        join fixtures f on f.id = gfg.fixture_id
        where gfg.game_id = %s
        group by gfg.gameweek
        having max(f.kickoff_at) >= now()
        order by gfg.gameweek asc
        limit 1
        """,
        (game_id,),
    )
    row = cur.fetchone()
    return row["gameweek"] if row else None


def main():
    load_env()
    conn = psycopg2.connect(os.environ["DATABASE_URL"], cursor_factory=psycopg2.extras.RealDictCursor)
    cur = conn.cursor()

    try:
        cur.execute("select id from fantasy_games where slug = 'eflfantasy'")
        row = cur.fetchone()
        if not row:
            raise SystemExit("No fantasy_games row for slug='eflfantasy' - run migration 0086 first.")
        game_id = row["id"]

        gameweek = resolve_current_gameweek(cur, game_id)
        if gameweek is None:
            print("No current/upcoming EFL Fantasy gameweek found - nothing to capture.")
            return

        live_players = fetch_players()
        live_by_external_id = {str(p["id"]): p for p in live_players}

        cur.execute(
            "select id, external_id from game_players where game_id = %s and is_active = true and position_code != 'CLUB'",
            (game_id,),
        )
        active_game_players = cur.fetchall()

        written = {"playing": 0, "injured": 0, "suspended": 0, "eliminated": 0, "unmatched": 0}
        for gp in active_game_players:
            live = live_by_external_id.get(gp["external_id"])
            if not live:
                written["unmatched"] += 1
                continue
            status = live.get("status")
            written[status] = written.get(status, 0) + 1
            cur.execute(
                """
                insert into eflfantasy_player_status
                    (game_player_id, gameweek, status, injury_detail, suspension_detail, scraped_at)
                values (%s, %s, %s, %s, %s, now())
                on conflict (game_player_id, gameweek) do update
                    set status = excluded.status, injury_detail = excluded.injury_detail,
                        suspension_detail = excluded.suspension_detail, scraped_at = excluded.scraped_at
                """,
                (
                    gp["id"], gameweek, status,
                    json.dumps(live["injuryDetails"]) if live.get("injuryDetails") else None,
                    json.dumps(live["suspensionDetails"]) if live.get("suspensionDetails") else None,
                ),
            )

        conn.commit()
        print(f"EFL Fantasy player status captured for gameweek {gameweek}: {written}")
    except Exception:
        conn.rollback()
        raise
    finally:
        cur.close()
        conn.close()

    # A captured injury/suspension only reaches real projected scores
    # once compute_projections.py re-runs - without this, the status
    # table updates but the pool/squad still shows whatever score was
    # computed before this run, same silent-staleness failure mode this
    # whole script exists to close. Only the one gameweek just captured -
    # cheap enough to run after every capture (several times a day),
    # unlike a full multi-gameweek recompute.
    subprocess.run(
        [sys.executable, "scripts/compute_projections.py", "eflfantasy", "--gameweek", str(gameweek)],
        cwd=ROOT,
        check=True,
    )


if __name__ == "__main__":
    main()
