"""
discover_cloudff.py
---------------------
Same approach as discover.py/discover_fanteam.py, for Cloud Fantasy
Football (cloud-ff.co.uk). Its public reference data (getPlayerStats,
the season fixtures on storage.googleapis.com) is already confirmed
unauthenticated - this script is only for the one remaining gap: the
exact real request shape for getUserTeam (your own squad), which live
manual probing couldn't pin down (it accepts the Authorization: Bearer
token - confirmed, a bad/expired token gets a distinct "Unauthorized
access"/"Missing or invalid token" response - but the real body/query
shape the app itself sends was never captured cleanly). Opens a real
browser, lets you log in and click into "Manage Team" by hand, and logs
every JSON API call so the real getUserTeam call (and saveUserTeam/
saveUserCaptain, for later) get captured directly from the app's own
code instead of guessed.

SETUP (already done for Dream Team/FanTeam, same environment):
    pip install playwright
    playwright install chromium

RUN:
    python3 discover_cloudff.py

A browser window opens at cloud-ff.co.uk. Log in, then click "Manage
Team" (and, if you're willing, make then undo a trivial change so
saveUserTeam/saveUserCaptain get captured too - not required, just a
bonus). Close the window when done to save results.
"""
import json
from pathlib import Path
from playwright.sync_api import sync_playwright

START_URL = "https://www.cloud-ff.co.uk/team"
OUTPUT_FILE = Path("discovered_calls_cloudff.json")
AUTH_STATE_FILE = Path("auth_state_cloudff.json")

INTERESTING_KEYWORDS = ["player", "stat", "price", "team", "squad", "gameweek", "user", "captain", "league", "login", "signup", "auth", "verify", "session"]

# Same caution as discover_fanteam.py: a credential-shaped request's body
# gets its VALUES redacted before anything is written to disk or printed
# - only field NAMES are ever kept. Every other captured request here
# (getUserTeam etc.) is already just team_id/gameweek numbers, not
# credentials, so those are left as-is.
CREDENTIAL_URL_KEYWORDS = ["login", "signup", "auth", "verify", "session"]
SENSITIVE_FIELD_SUBSTRINGS = ["pass", "pwd", "secret", "token", "email", "user", "login", "identifier"]

captured = []


def looks_interesting(url: str) -> bool:
    url_lower = url.lower()
    return any(kw in url_lower for kw in INTERESTING_KEYWORDS)


def is_credential_shaped(url: str) -> bool:
    url_lower = url.lower()
    return any(kw in url_lower for kw in CREDENTIAL_URL_KEYWORDS)


def redact_body(raw_post_data):
    """None, or {field_name: "<redacted>"} for every field - proves which
    field names a login-shaped request actually uses without ever saving
    a real credential value anywhere (same approach as
    discover_fanteam.py's redact_body)."""
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
    if request.method not in ("GET", "POST"):
        return
    if "cloudfunctions.net" not in request.url:
        return
    if not looks_interesting(request.url):
        return
    try:
        credential_shaped = is_credential_shaped(request.url)
        body_to_store = redact_body(request.post_data) if credential_shaped else request.post_data
        captured.append({
            "phase": "request",
            "method": request.method,
            "url": request.url,
            "headers": {k: v for k, v in request.headers.items() if k.lower() not in ("authorization", "cookie")},
            "has_auth_header": "authorization" in {k.lower() for k in request.headers},
            "post_data": body_to_store,
            "post_data_redacted": credential_shaped,
        })
        print(f"\n[REQUEST] {request.method} {request.url}")
        if credential_shaped:
            print(f"  body field names (values redacted): {body_to_store}")
        elif request.post_data:
            print(f"  body: {request.post_data[:300]}")
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
        captured.append({"phase": "response", "url": response.url, "status": response.status, "sample": body})
        print(f"[RESPONSE] {response.status} {response.url}")
        preview = json.dumps(body, indent=2)[:800]
        print(preview + ("..." if len(preview) == 800 else ""))
    except Exception as e:
        print(f"[warn] couldn't process response from {response.url}: {e}")


def main():
    with sync_playwright() as p:
        browser = p.chromium.launch(headless=False)
        context = browser.new_context()
        page = context.new_page()
        page.on("request", handle_request)
        page.on("response", handle_response)

        print(f"Opening {START_URL} ...")
        page.goto(START_URL, wait_until="domcontentloaded")

        print(
            "\n>>> A browser window is open.\n"
            ">>> 1. Log in manually.\n"
            ">>> 2. Click 'Manage Team' to load your real squad.\n"
            ">>> 3. Watch this terminal for [REQUEST]/[RESPONSE] entries.\n"
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
    print(f"\nSaved {len(captured)} captured calls to {OUTPUT_FILE.resolve()}")
    print(f"Saved your logged-in session to {AUTH_STATE_FILE}.")


if __name__ == "__main__":
    main()
