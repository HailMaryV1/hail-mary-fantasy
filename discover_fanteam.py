"""
discover_fanteam.py
--------------------
Same approach as discover.py, adapted for FanTeam now that the 2026/27
season is live. FanTeam is also a JS single-page app, so player prices,
gameweek info, and live scoring aren't in the raw HTML - they're loaded
via background API calls. This opens a real browser, lets you log in
and click around your team/fixtures/stats pages by hand, and logs every
JSON API call so we can find the real endpoints without guessing.

Separate output files from discover.py (auth_state_fanteam.json,
discovered_calls_fanteam.json) so this doesn't clobber the Dream Team
capture from earlier.

SETUP (already done for Dream Team, same environment):
    pip install playwright
    playwright install chromium

RUN:
    python3 discover_fanteam.py

A browser window will open at your FanTeam contest page. Log in
manually, then navigate around your squad, fixtures, and player stats
pages. The script keeps listening until you close the browser window.
"""

import json
from pathlib import Path
from playwright.sync_api import sync_playwright

START_URL = "https://www.fanteam.com/fantasy/participate/1131482"
OUTPUT_FILE = Path("discovered_calls_fanteam.json")
AUTH_STATE_FILE = Path("auth_state_fanteam.json")

# Keywords that suggest an API response is about players/stats/prices/fixtures.
INTERESTING_KEYWORDS = ["player", "stat", "price", "team", "squad", "gameweek", "fixture", "round", "score", "leaderboard"]

# Real request bodies get captured too now (added after discovering the
# login endpoint accepts SOMETHING in an "email" field, but never having
# proof of the real field name for a username-based login) - so any
# field that could plausibly hold a credential gets its VALUE redacted
# before anything is written to disk or printed. Only field NAMES ever
# get saved for a login-shaped request - never a real password, never a
# real username/email either, out of caution.
SENSITIVE_FIELD_SUBSTRINGS = ["pass", "pwd", "secret", "token", "email", "user", "login", "identifier"]

captured = []


def looks_interesting(url: str) -> bool:
    url_lower = url.lower()
    return any(kw in url_lower for kw in INTERESTING_KEYWORDS)


def redact_body(raw_post_data):
    """None, or {field_name: "<redacted>"} for every field - proves which
    field names a login-shaped request actually uses without ever saving
    a real credential value anywhere."""
    if not raw_post_data:
        return None
    try:
        parsed = json.loads(raw_post_data)
    except Exception:
        return {"_unparseable_body_length": len(raw_post_data)}
    if isinstance(parsed, dict):
        return {k: "<redacted>" for k in parsed.keys()}
    return {"_non_object_body_type": type(parsed).__name__}


def handle_request(request):
    if request.method != "POST":
        return
    if "login" not in request.url.lower() and "auth" not in request.url.lower() and "session" not in request.url.lower():
        return
    try:
        entry = {"phase": "request", "method": request.method, "url": request.url, "body_field_names": redact_body(request.post_data)}
        captured.append(entry)
        print(f"\n[REQUEST] {request.method} {request.url}")
        print(f"  body field names (values redacted): {entry['body_field_names']}")
    except Exception as e:
        print(f"[warn] couldn't process request to {request.url}: {e}")


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
        page.on("request", handle_request)

        print(f"Opening {START_URL} ...")
        page.goto(START_URL, wait_until="domcontentloaded")

        print(
            "\n>>> A browser window is open.\n"
            ">>> 1. Log in manually.\n"
            ">>> 2. Navigate to your squad, fixtures, and player stats pages.\n"
            ">>> 3. Watch this terminal for [CAPTURED] entries - those are the\n"
            "        API calls carrying player/stat/price/fixture data.\n"
            ">>> 4. Close the browser window when you're done to save results.\n"
        )

        try:
            while True:
                page.wait_for_timeout(1000)
                if page.is_closed():
                    break
        except Exception:
            pass

        context.storage_state(path=str(AUTH_STATE_FILE))
        browser.close()

    OUTPUT_FILE.write_text(json.dumps(captured, indent=2))
    print(f"\nSaved {len(captured)} captured API calls to {OUTPUT_FILE.resolve()}")
    print(f"Saved your logged-in session to {AUTH_STATE_FILE}.")
    print("Send me the discovered_calls_fanteam.json file (or just tell me to look at it)")
    print("once you've clicked through your squad/fixtures/stats pages.")


if __name__ == "__main__":
    main()
