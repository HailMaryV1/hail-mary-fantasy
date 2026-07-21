"""
scraper_fanteam_golf.py
-------------------------
Pulls one FanTeam golf tournament's full player pool and writes raw JSON
for import_fanteam_golf.py to consume. Mirrors scraper_fanteam.py's
fetch_players() exactly - same backend (fanteam-game.api.scoutgg.net),
same "fully unauthenticated, HTTP 200 with no login" confirmed live
against a real tournament (1131817, "The 3M Open") - just a different
sport (golf, not football) and a caller-supplied tournament ID instead of
a hardcoded one, since a new golf tournament comes up every week and this
is meant to be re-run against a fresh URL each time (see the weekly
workflow in the approved plan).

Takes either a bare tournament ID or the full FanTeam participation URL
(https://www.fanteam.com/fantasy/participate/{id}) - paste either.

RUN:
    python3 scraper_fanteam_golf.py <tournament_id_or_url>
"""

import json
import re
import sys
import time
import urllib.error
import urllib.request
from pathlib import Path

BASE = "https://fanteam-game.api.scoutgg.net"
OUT = Path("golf_tournament_raw.json")


def parse_tournament_id(arg: str) -> str:
    match = re.search(r"/participate/(\d+)", arg)
    if match:
        return match.group(1)
    if arg.strip().isdigit():
        return arg.strip()
    raise SystemExit(f"Couldn't extract a tournament ID from {arg!r} - pass a bare ID or a fanteam.com/fantasy/participate/<id> URL.")


def fetch_json(url, retries=3, backoff_seconds=5):
    # Same retry/backoff reasoning as scraper_fanteam.py's fetch_json - a
    # one-off transient blip (rate-limiting, a momentary WAF hiccup)
    # shouldn't kill the whole import for what's otherwise a reliably
    # unauthenticated, working endpoint.
    req = urllib.request.Request(url, headers={"User-Agent": "Mozilla/5.0"})
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
        raise SystemExit("Usage: python3 scraper_fanteam_golf.py <tournament_id_or_participate_url>")
    tournament_id = parse_tournament_id(sys.argv[1])

    print(f"Fetching golf tournament {tournament_id} ...")
    status, data = fetch_json(f"{BASE}/tournaments/{tournament_id}/players?round=editable")
    if status != 200:
        raise SystemExit(f"Tournament request failed: HTTP {status}")

    tournament_name = data.get("tournament", {}).get("name", "?")
    game_type = data.get("tournament", {}).get("gameType", "?")
    if game_type != "golf":
        print(f"  WARNING: tournament {tournament_id}'s gameType is {game_type!r}, not 'golf' - wrong ID?")

    OUT.write_text(json.dumps(data, indent=2))
    print(f"  \"{tournament_name}\" - {len(data.get('playerChoices', []))} golfers -> {OUT}")
    print("\nDone. Run import_fanteam_golf.py next to load this into Supabase.")


if __name__ == "__main__":
    main()
