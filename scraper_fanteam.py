"""
scraper_fanteam.py
-------------------
Pulls the two FanTeam endpoints found during discovery (discover_fanteam.py)
and writes raw JSON for import_fanteam_live.py to consume.

Player prices/lineup/status (`fetch_players`): confirmed live on
2026-07-19 that this endpoint returns full data with NO Authorization
header at all - HTTP 200 unauthenticated, same content as the
authenticated call. Plain urllib.request, no Playwright/browser needed.
This is the half that runs on the automated schedule (see
scripts/refresh_all.py) - it needs no login, so nothing here can expire.

Season fixture list (`fetch_fixtures`): DOES need the Authorization
header FanTeam's API expects (a bearer token it keeps in localStorage as
"ftToken", not just cookies - confirmed by inspecting
auth_state_fanteam.json directly). Only used to map fixtures to real
gameweek numbers, which barely changes once the season calendar is
published - kept as a manual, occasional path (default behaviour, or
`--fixtures-only`), not part of the automated pipeline.

RUN:
    python3 scraper_fanteam.py                # both (fixtures needs local login)
    python3 scraper_fanteam.py --players-only  # just players - no login needed, used by CI
    python3 scraper_fanteam.py --fixtures-only # just fixtures - needs auth_state_fanteam.json
"""

import json
import sys
import time
import urllib.error
import urllib.request
from pathlib import Path

AUTH_STATE_FILE = Path("auth_state_fanteam.json")
TOURNAMENT_ID = "1131482"
BASE = "https://fanteam-game.api.scoutgg.net"

PLAYERS_OUT = Path("fanteam_players_raw.json")
FIXTURES_OUT = Path("fanteam_fixtures_raw.json")


def get_ft_token():
    state = json.loads(AUTH_STATE_FILE.read_text(encoding="utf-8"))
    for origin in state.get("origins", []):
        if origin["origin"] == "https://www.fanteam.com":
            for item in origin.get("localStorage", []):
                if item["name"] == "ftToken":
                    return item["value"]
    raise SystemExit("ftToken not found in auth_state_fanteam.json - re-run discover_fanteam.py and log in.")


def fetch_json(url, headers=None, retries=8, backoff_seconds=30):
    # A single bad response used to kill the whole twice-daily run outright
    # (confirmed live: a one-off HTTP 401 from this endpoint - which is
    # otherwise reliably unauthenticated, see the module docstring - broke
    # the 2026-07-21 morning run even though the endpoint was back to a
    # normal 200 minutes later). Retrying a few times with a short pause
    # covers exactly that class of transient blip (rate-limiting, a
    # momentary WAF hiccup, a dropped connection) without masking a real,
    # persistent failure - it still gives up and reports the failure after
    # `retries` attempts.
    #
    # Widened 3 retries/5s (~15s total) -> 8 retries/30s (~3.5min total)
    # 2026-08-22: a real run hit 3 straight HTTP 401s and gave up, cascading
    # into import_fanteam_live.py crashing on a missing raw-data file for
    # the whole cycle - confirmed live minutes later the endpoint had
    # already recovered to a normal 200, so the old window was simply too
    # short for this specific blip. The job timeout has 120 minutes of
    # headroom (see refresh_fanteam.yml), so trading a few extra minutes
    # here for actually riding out a multi-minute blip is a clear win over
    # losing an entire refresh cycle's fresh player data.
    req = urllib.request.Request(url, headers={"User-Agent": "Mozilla/5.0", **(headers or {})})
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


def fetch_players():
    print("Fetching player prices ...")
    status, players_data = fetch_json(f"{BASE}/tournaments/{TOURNAMENT_ID}/players?round=editable")
    if status != 200:
        print(f"Players request failed: HTTP {status}")
        return False
    PLAYERS_OUT.write_text(json.dumps(players_data, indent=2))
    print(f"  {len(players_data.get('playerChoices', []))} players -> {PLAYERS_OUT}")
    return True


def fetch_fixtures():
    # Needs the real login session (bearer token alone via plain urllib
    # gets a 401 - confirmed live; Playwright's request context, replaying
    # the full saved browser session, is what actually works here).
    if not AUTH_STATE_FILE.exists():
        print("auth_state_fanteam.json not found - run discover_fanteam.py and log in first. Skipping fixtures.")
        return False
    from playwright.sync_api import sync_playwright

    token = get_ft_token()
    print("Fetching season fixtures ...")
    with sync_playwright() as p:
        browser = p.chromium.launch(headless=True)
        context = browser.new_context(storage_state=str(AUTH_STATE_FILE))
        resp = context.request.get(
            f"{BASE}/real_matches?tournament_id={TOURNAMENT_ID}", headers={"Authorization": f"Bearer {token}"}
        )
        if resp.status != 200:
            print(f"Fixtures request failed: HTTP {resp.status}")
            print(resp.text()[:500])
            browser.close()
            return False
        fixtures_data = resp.json()
        browser.close()

    FIXTURES_OUT.write_text(json.dumps(fixtures_data, indent=2))
    print(f"  {len(fixtures_data.get('realMatches', []))} fixtures -> {FIXTURES_OUT}")
    return True


def main():
    args = sys.argv[1:]
    do_players = "--fixtures-only" not in args
    do_fixtures = "--players-only" not in args

    ok = True
    if do_players:
        ok = fetch_players() and ok
    if do_fixtures:
        ok = fetch_fixtures() and ok

    if ok:
        print("\nDone. Run import_fanteam_live.py next to load this into Supabase.")
    else:
        raise SystemExit("One or more fetches failed - see above.")


if __name__ == "__main__":
    main()
