"""
discover.py
------------
Step 1 of 2. dreamteamfc.com is a JavaScript single-page app, so player
stats/prices are NOT in the raw HTML - they're loaded via background
API (XHR/fetch) calls after the page loads. Instead of trying to parse
fragile rendered HTML, this script opens a real browser, lets you log
in by hand, and then logs every JSON API call the site makes while you
click around the Stats Centre / player list pages.

Once you run this and click through the site, look at the printed
output (and discovered_calls.json) to find the endpoint(s) that return
player names, stats, and prices. Then plug that URL into scraper.py.

SETUP (run once):
    pip install playwright
    playwright install chromium

RUN:
    python3 discover.py

A browser window will open. Log in manually, then navigate to the
Stats Centre and any player list / price pages. The script keeps
listening until you close the browser window.
"""

import json
from pathlib import Path
from playwright.sync_api import sync_playwright

OUTPUT_FILE = Path("discovered_calls.json")
# Keywords that suggest an API response is about players/stats/prices.
# Add more if you know terms the site might use (e.g. "squad", "prices").
INTERESTING_KEYWORDS = ["player", "stat", "price", "team", "squad", "gameweek"]

captured = []


def looks_interesting(url: str) -> bool:
    url_lower = url.lower()
    return any(kw in url_lower for kw in INTERESTING_KEYWORDS)


def handle_response(response):
    try:
        content_type = response.headers.get("content-type", "")
        if "json" not in content_type:
            return
        if not looks_interesting(response.url):
            return

        try:
            body = response.json()
        except Exception:
            return

        entry = {
            "url": response.url,
            "status": response.status,
            "sample": body if isinstance(body, (dict, list)) else str(body)[:500],
        }
        captured.append(entry)
        print(f"\n[CAPTURED] {response.status}  {response.url}")
        # Print a short preview so you can eyeball it live in the terminal
        preview = json.dumps(body, indent=2)[:800]
        print(preview + ("..." if len(preview) == 800 else ""))

    except Exception as e:
        print(f"[warn] couldn't process response from {response.url}: {e}")


def main():
    with sync_playwright() as p:
        browser = p.chromium.launch(headless=False)
        context = browser.new_context()
        page = context.new_page()
        page.on("response", handle_response)

        print("Opening dreamteamfc.com ...")
        page.goto("https://www.dreamteamfc.com/", wait_until="domcontentloaded")

        print(
            "\n>>> A browser window is open.\n"
            ">>> 1. Log in manually.\n"
            ">>> 2. Navigate to the Stats Centre and any player/price pages.\n"
            ">>> 3. Watch this terminal for [CAPTURED] entries - those are the\n"
            "        API calls carrying player/stat/price data.\n"
            ">>> 4. Close the browser window when you're done to save results.\n"
        )

        # Keep the script alive until the user closes the browser
        try:
            while True:
                page.wait_for_timeout(1000)
                if page.is_closed():
                    break
        except Exception:
            pass

        # Save the logged-in session (cookies etc) so scraper.py can reuse it
        # without you having to log in again.
        context.storage_state(path="auth_state.json")
        browser.close()

    OUTPUT_FILE.write_text(json.dumps(captured, indent=2))
    print(f"\nSaved {len(captured)} captured API calls to {OUTPUT_FILE.resolve()}")
    print("Saved your logged-in session to auth_state.json (scraper.py reuses this).")
    print("Open discovered_calls.json, find the entry with player/stat/price")
    print("data, and copy its URL into scraper.py's API_URL variable.")


if __name__ == "__main__":
    main()
