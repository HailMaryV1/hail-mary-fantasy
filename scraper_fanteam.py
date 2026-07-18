"""
scraper_fanteam.py
-------------------
Step 2 of 2 for FanTeam (run discover_fanteam.py first). Replays the two
endpoints found during discovery - the live player price list and the
full season fixture list - using the saved login session, and writes
raw JSON for import_fanteam_live.py to consume.

Unlike Dream Team, FanTeam's API needs an explicit Authorization header
(a bearer token it keeps in localStorage as "ftToken", not just cookies)
- confirmed by inspecting auth_state_fanteam.json directly. Playwright's
request context doesn't run page JS, so it won't attach that header on
its own; this script extracts the token and sets it manually.

SETUP:
    (same as discover_fanteam.py - playwright already installed)

RUN:
    python3 scraper_fanteam.py
"""

import json
from pathlib import Path
from playwright.sync_api import sync_playwright

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


def main():
    if not AUTH_STATE_FILE.exists():
        raise SystemExit("auth_state_fanteam.json not found. Run discover_fanteam.py first and log in.")

    token = get_ft_token()

    with sync_playwright() as p:
        browser = p.chromium.launch(headless=True)
        context = browser.new_context(storage_state=str(AUTH_STATE_FILE))
        headers = {"Authorization": f"Bearer {token}"}

        print("Fetching player prices ...")
        resp = context.request.get(f"{BASE}/tournaments/{TOURNAMENT_ID}/players?round=editable", headers=headers)
        if resp.status != 200:
            print(f"Players request failed: HTTP {resp.status}")
            print(resp.text()[:500])
            browser.close()
            return
        players_data = resp.json()
        PLAYERS_OUT.write_text(json.dumps(players_data, indent=2))
        print(f"  {len(players_data.get('playerChoices', []))} players -> {PLAYERS_OUT}")

        print("Fetching season fixtures ...")
        resp = context.request.get(f"{BASE}/real_matches?tournament_id={TOURNAMENT_ID}", headers=headers)
        if resp.status != 200:
            print(f"Fixtures request failed: HTTP {resp.status}")
            print(resp.text()[:500])
            browser.close()
            return
        fixtures_data = resp.json()
        FIXTURES_OUT.write_text(json.dumps(fixtures_data, indent=2))
        print(f"  {len(fixtures_data.get('realMatches', []))} fixtures -> {FIXTURES_OUT}")

        browser.close()

    print("\nDone. Run import_fanteam_live.py next to load this into Supabase.")


if __name__ == "__main__":
    main()
