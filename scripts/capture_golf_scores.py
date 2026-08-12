"""
capture_golf_scores.py
------------------------
Twice-daily-only capture of a golf tournament's real scores (2026-08-12
fix). The real gap this closes: once a tournament's picks lock,
scraper_fanteam_golf.py's endpoint (?round=editable) starts 401ing
permanently (see its own docstring), so refresh_all.py's twice-daily
re-scrape/re-import silently stopped updating anything the moment a
tournament went live - golf_tournament_entries.raw froze at its
pre-lock snapshot and attach_golf_tournament_results.py had nothing
real to attach, ever (confirmed live: Wyndham Championship's 138
entries all sat frozen at their original import timestamp, 8 days
after picks locked).

Uses the SAME live-scoring endpoint poll_golf_live_scores.py already
proved works (?round=<event_number>, unauthenticated with the
LIVE_HEADERS Bearer token below - confirmed against FanTeam's own
frontend network calls) - but deliberately stripped down to just the
score write. No leaderboard-leader tracking, no remaining-holes, no
push notifications: those are genuinely "live experience" features
tied to poll_golf_live_scores.py's 5-minute cadence
(.github/workflows/golf_live_scores.yml), which stays disabled on
purpose - the user explicitly wants final results captured, not a
continuously-updating leaderboard, so this runs from refresh_all.py's
existing twice-daily schedule instead of its own 5-minute cron.
active_golf_tournaments() (refresh_all.py) already keeps a tournament
in the refresh set for 48h past its end_time specifically to give this
a few retries in case FanTeam is slow to post the truly final score.

Deliberately overwrites golf_tournament_entries.raw wholesale (matching
both poll_golf_live_scores.py's and import_fanteam_golf.py's existing
convention, not a merge) - refresh_all.py runs this step AFTER the
pre-tournament re-scrape/re-import steps so a locked tournament's real
score data is never immediately clobbered by the (now permanently
failing, since picks are locked) pricing re-scrape/re-import.

RUN:
    python3 scripts/capture_golf_scores.py <fanteam_tournament_id>
"""

import json
import os
import sys
import time
import urllib.error
import urllib.request
from pathlib import Path

import psycopg2
import psycopg2.extras

sys.path.insert(0, str(Path(__file__).resolve().parent))
from activity_log import log_event  # noqa: E402

ROOT = Path(__file__).resolve().parent.parent
BASE = "https://fanteam-game.api.scoutgg.net"

# Same fixed, non-secret constant as poll_golf_live_scores.py's
# LIVE_HEADERS - see that script's docstring for why it's safe to
# hardcode (a public frontend-bundle value, not a per-user token).
LIVE_HEADERS = {
    "User-Agent": "Mozilla/5.0",
    "Accept": "application/json",
    "Authorization": "Bearer fanteam",
    "Origin": "https://www.fanteam.com",
    "Referer": "https://www.fanteam.com/",
}


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


def fetch_json(url, retries=3, backoff_seconds=5):
    req = urllib.request.Request(url, headers=LIVE_HEADERS)
    last_status = None
    for attempt in range(1, retries + 1):
        try:
            with urllib.request.urlopen(req, timeout=30) as resp:
                return resp.status, json.loads(resp.read())
        except urllib.error.HTTPError as e:
            last_status = e.code
        except urllib.error.URLError as e:
            print(f"  Network error on attempt {attempt}/{retries}: {e.reason}")
            last_status = None
        if attempt < retries:
            status_desc = f"HTTP {last_status}" if last_status is not None else "a network error"
            print(f"  Attempt {attempt}/{retries} got {status_desc} - retrying in {backoff_seconds}s ...")
            time.sleep(backoff_seconds)
    return last_status, None


def main():
    if len(sys.argv) < 2:
        raise SystemExit("Usage: python3 scripts/capture_golf_scores.py <fanteam_tournament_id>")
    fanteam_tournament_id = sys.argv[1]

    load_env()
    conn = psycopg2.connect(os.environ["DATABASE_URL"])
    conn.autocommit = False
    cur = conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor)

    try:
        cur.execute(
            "select id, name, event_number from golf_tournaments where fanteam_tournament_id = %s",
            (fanteam_tournament_id,),
        )
        tournament = cur.fetchone()
        if not tournament:
            raise SystemExit(f"No golf_tournaments row for fanteam_tournament_id {fanteam_tournament_id!r} - import it first.")

        print(f"Capturing scores for {tournament['name']!r} (gameweek {tournament['event_number']}) ...")
        status, data = fetch_json(f"{BASE}/tournaments/{fanteam_tournament_id}/players?round={tournament['event_number']}")
        if status != 200:
            raise SystemExit(f"Live players request failed: HTTP {status}")

        changed = 0
        for pc in data.get("playerChoices", []):
            external_player_id = str(pc["realPlayerId"])
            new_points = pc.get("points")
            if new_points is None:
                continue

            cur.execute(
                """
                select gte.id, gte.game_player_id, gte.raw, g.full_name
                from golf_tournament_entries gte
                left join game_players gp on gp.id = gte.game_player_id
                left join golfers g on g.id = gp.golfer_id
                where gte.tournament_id = %s and gte.external_player_id = %s
                """,
                (tournament["id"], external_player_id),
            )
            entry = cur.fetchone()
            if not entry or not entry["game_player_id"]:
                continue  # golfer not in our imported pool (or never matched to a game_player)

            old_raw = entry["raw"] or {}
            if isinstance(old_raw, str):
                old_raw = json.loads(old_raw)
            old_points = old_raw.get("points")

            cur.execute(
                "update golf_tournament_entries set raw = %s, updated_at = now() where id = %s",
                (json.dumps(pc), entry["id"]),
            )

            if old_points is None or float(old_points) != float(new_points):
                changed += 1
                golfer_name = entry["full_name"] or "Unknown golfer"
                log_event(
                    cur,
                    "golf_score_changed",
                    f"{golfer_name}: {float(new_points):.1f} pts - {tournament['name']}",
                    game_player_id=entry["game_player_id"],
                    details={"tournament_id": tournament["id"], "old_points": old_points, "new_points": new_points},
                )

        conn.commit()
        print(f"{changed} golfer score(s) updated.")
    except Exception:
        conn.rollback()
        raise
    finally:
        cur.close()
        conn.close()


if __name__ == "__main__":
    main()
