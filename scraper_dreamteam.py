"""
scraper_dreamteam.py
----------------------
Pulls Dream Team's real reference data - confirmed live, unauthenticated
JSON:

    GET https://engagecraft-fantasy-backend-prod.azurewebsites.net/api/players
        -> {"success": true, "data": {"items": [
             {"id" (uuid), "squadId" (uuid), "teamName" (e.g. "Chelsea FC"),
              "firstName", "lastName", "position" ("GK"/"DEF"/"MID"/"STR" -
              confirmed live to already match this project's existing
              Dream Team position_code vocabulary exactly, no mapping
              needed), "price", "availabilityDisplay", "optaPersonId",
              "currentPeriodFixtures", "isVisible", "hasLeft", ...}, ...
           ]}}
        Confirmed live: 670 real players across the real 20-club 2026/27
        Premier League (includes Coventry City, excludes West Ham/
        Wolverhampton Wanderers/Burnley - matches the relegation already
        applied by deactivate_relegated_dreamteam_players.py).

Dream Team was previously seeded only from a one-off historical CSV
(import_historical_data.py) with no live source at all (see refresh_all.
py's own docstring) - this is the first real live scrape. No login
needed, matching the pattern already established for FanTeam's and Cloud
FF's own unauthenticated player-pool pulls.

RUN:
    python3 scraper_dreamteam.py
"""
import json
import time
import urllib.error
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parent

PLAYERS_URL = "https://engagecraft-fantasy-backend-prod.azurewebsites.net/api/players"


def fetch_json(url, retries=3, backoff_seconds=5):
    # Retries a transient network blip (URLError/TimeoutError) a few
    # times before giving up for real - same fix already proven for
    # scraper_fanteam.py's own fetch_json, applied here since this
    # script runs unattended on the same automated schedule.
    req = urllib.request.Request(url, headers={"User-Agent": "Mozilla/5.0", "Accept": "application/json"})
    last_error = None
    for attempt in range(1, retries + 1):
        try:
            with urllib.request.urlopen(req, timeout=30) as resp:
                return json.loads(resp.read().decode("utf-8"))
        except (urllib.error.URLError, TimeoutError) as e:
            last_error = e
            if attempt < retries:
                print(f"  [retry] {url}: attempt {attempt}/{retries} failed ({e}) - retrying in {backoff_seconds}s ...")
                time.sleep(backoff_seconds)
    raise last_error


def main():
    body = fetch_json(PLAYERS_URL)
    if not body.get("success"):
        raise SystemExit(f"Dream Team players endpoint returned success=false: {body}")
    players = body["data"]["items"]
    (ROOT / "dreamteam_players_raw.json").write_text(json.dumps(players, indent=2, ensure_ascii=False), encoding="utf-8")
    print(f"Saved {len(players)} real players to dreamteam_players_raw.json")


if __name__ == "__main__":
    main()
