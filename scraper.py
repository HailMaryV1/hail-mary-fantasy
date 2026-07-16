"""
scraper.py
-----------
Step 2 of 2. Run discover.py FIRST - it logs you in, captures the site's
internal API calls, and saves your session to auth_state.json.

Once you've found the right endpoint in discovered_calls.json, paste it
into API_URL below. This script replays that call using your saved
login session (via Playwright's request context, so cookies/auth carry
over automatically) and writes the player data to a CSV.

You WILL need to adjust the FIELD MAPPING section below once you see
the real shape of the JSON - I can't know the exact field names without
being able to log in and inspect the site myself. Print the raw JSON
first (the script does this automatically) and adjust from there.

SETUP:
    pip install playwright
    playwright install chromium
    (run discover.py first so auth_state.json exists)

RUN:
    python3 scraper.py
"""

import csv
import json
from pathlib import Path
from playwright.sync_api import sync_playwright

# --- EDIT THIS after running discover.py and inspecting discovered_calls.json ---
API_URL = "https://www.dreamteamfc.com/PASTE/THE/REAL/API/ENDPOINT/HERE"
# ----------------------------------------------------------------------------

AUTH_STATE = Path("auth_state.json")
OUTPUT_CSV = Path("players.csv")


def main():
    if not AUTH_STATE.exists():
        raise SystemExit(
            "auth_state.json not found. Run discover.py first, log in, "
            "and close the browser window to save your session."
        )

    with sync_playwright() as p:
        browser = p.chromium.launch(headless=True)
        context = browser.new_context(storage_state=str(AUTH_STATE))

        print(f"Requesting {API_URL} ...")
        response = context.request.get(API_URL)

        if response.status != 200:
            print(f"Request failed: HTTP {response.status}")
            print(response.text()[:1000])
            browser.close()
            return

        data = response.json()
        browser.close()

    # Dump raw JSON so you can see its real structure and fix the mapping below
    Path("raw_response.json").write_text(json.dumps(data, indent=2))
    print("Saved raw API response to raw_response.json - inspect it to confirm field names.")

    # --- FIELD MAPPING: adjust this to match the real JSON structure ---
    # Common shapes: a top-level list of players, or {"players": [...]}.
    # Uncomment/adjust once you've looked at raw_response.json.
    players = data if isinstance(data, list) else data.get("players", [])

    if not players:
        print("No players found - check raw_response.json and update the "
              "FIELD MAPPING section in this script.")
        return

    rows = []
    for p_ in players:
        rows.append({
            "name": p_.get("name") or p_.get("playerName") or p_.get("fullName"),
            "team": p_.get("team") or p_.get("clubName"),
            "position": p_.get("position") or p_.get("pos"),
            "price": p_.get("price") or p_.get("value") or p_.get("cost"),
            "points": p_.get("points") or p_.get("totalPoints"),
            # Add more fields here once you see what's available
        })

    with OUTPUT_CSV.open("w", newline="", encoding="utf-8") as f:
        writer = csv.DictWriter(f, fieldnames=rows[0].keys())
        writer.writeheader()
        writer.writerows(rows)

    print(f"Wrote {len(rows)} players to {OUTPUT_CSV.resolve()}")


if __name__ == "__main__":
    main()
