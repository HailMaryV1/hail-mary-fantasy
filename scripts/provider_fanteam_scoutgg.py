"""
provider_fanteam_scoutgg.py
----------------------------
Auto Import My Squad - FanTeam provider adapter. Covers FanTeam Football,
FanTeam Golf and FanTeam NFL at once - all three are one Scout Gaming
account (confirmed live: discovered_calls_fanteam.json's captured
tournaments/@me response lists fantasyTeams across many different
tournamentIds under a single real userId, and scraper_fanteam_golf.py
already hits the exact same fanteam-game.api.scoutgg.net backend as
football) - one login, many teams, distinguished by tournament_id only.

Two real mechanisms, confirmed live against the user's actual account on
2026-07-30, not guessed:

1. Login + "which teams do I have" - a plain, fast JSON REST API.
     POST https://fanteam-scott.api.scoutgg.net/api/users/login
       {"username": ..., "password": ...} -> {"token": <JWT, ~3h>, "refreshToken": ...}
     FanTeam accounts are username-based, not email-based - confirmed
     live via the server's own error (a real account's real username
     sent under an "email" key got HTTP 400 {"error": "Username
     required"}), not assumed from a discovery capture like everything
     else in this file.
     GET  https://fanteam-game.api.scoutgg.net/tournaments/@me
       (Authorization: Bearer <token>) -> {"fantasyTeams": [{"id", "tournamentId", ...}, ...]}
   No confirmed silent-refresh endpoint was found during discovery (the
   captured refreshToken's own `exp` claim was already identical to the
   access token's, and no distinct refresh URL ever appeared in 82
   captured real API calls) - re-login with the stored (encrypted)
   password on every sync run instead of trying to guess one. Revisit if
   a real refresh endpoint is ever found; until then this is auth_method
   'encrypted_password' by design, not by default - see
   provider_credentials' auth_method tiering in migration 0071.

2. Reading one team's actual picks - NOT a JSON endpoint. FanTeam's own
   squad-builder page (https://www.fanteam.com/fantasy/edit/{tournamentId}/{teamId})
   renders the whole squad from an opaque, client-encoded URL segment its
   own app resolves - confirmed live that visiting the URL WITHOUT that
   segment still works (FanTeam's app redirects and fills it in itself),
   so only tournamentId/teamId (both real, from tournaments/@me) are
   needed to reach a team - and the rendered result lives inside deeply
   nested Shadow DOM (native Stencil.js-style <ft-*> web components -
   confirmed live: document.querySelectorAll finds nothing, but walking
   every element's own .shadowRoot recursively and collecting leaf text
   nodes in DOM order reproduces the exact real squad, confirmed against
   a real 15-player FanTeam Football entry - GK Roefs, DEF Gabriel/
   Timber/Shaw, MID Rice/Anderson/Semenyo/Fernandes(VC)/Garner, FWD
   Haaland(C)/Sesko, bench Kelleher/Tarkowski/Isidor/O'Brien). No CSS
   selectors or class names used anywhere below - those are exactly the
   kind of thing a redesign silently breaks; this only depends on the
   semantic reading order of the text FanTeam itself renders, which is
   far more stable.

Real squad token grammar (confirmed, not guessed) per starting-XI player:
    [captain-badge?] name, team_short, opponent_short, price
followed once per position group by that group's label
("Goalkeeper"/"Defender"/"Midfielder"/"Forward" - AFTER the group, not
before, in DOM order). Bench players carry their own short position code
("GK"/"DEF"/"MID"/"FOR") immediately after their own price instead of a
shared group label. Captain badge is the literal token "C" immediately
before the name; vice-captain is "VC".

Not a standalone script - imported by scripts/sync_provider_squads.py.
"""
import json
import os
import time
import urllib.error
import urllib.request

LOGIN_URL = "https://fanteam-scott.api.scoutgg.net/api/users/login"
GAME_BASE = "https://fanteam-game.api.scoutgg.net"
EDIT_URL_TEMPLATE = "https://www.fanteam.com/fantasy/edit/{tournament_id}/{team_id}"

STARTING_SECTION_LABELS = {"Goalkeeper", "Defender", "Midfielder", "Forward"}
BENCH_POSITION_CODES = {"GK", "DEF", "MID", "FOR"}
PRICE_RE = r"^\d+(\.\d+)?M$"


def _http_json(url, method="GET", headers=None, body=None, timeout=20):
    data = json.dumps(body).encode() if body is not None else None
    req = urllib.request.Request(url, data=data, method=method, headers={
        "User-Agent": "Mozilla/5.0",
        "Content-Type": "application/json",
        **(headers or {}),
    })
    try:
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            return resp.status, json.loads(resp.read())
    except urllib.error.HTTPError as e:
        try:
            return e.code, json.loads(e.read())
        except Exception:
            return e.code, None


def login(username, password):
    """(access_token, refresh_token, profile) or raises. Real endpoint,
    confirmed live - see module docstring. The field is genuinely named
    "username" (confirmed live: a real login attempt with the account's
    real FanTeam username in an "email" field got HTTP 400 {"error":
    "Username required"} - FanTeam accounts are username-based, not
    email-based, unlike most of this project's other integrations)."""
    status, body = _http_json(LOGIN_URL, method="POST", body={"username": username, "password": password})
    if status != 200 or not body or "token" not in body:
        raise RuntimeError(f"FanTeam login failed: HTTP {status} {body}")
    return body["token"], body.get("refreshToken"), body.get("profile")


def list_my_teams(access_token):
    """[{"fantasy_team_id": str, "tournament_id": str}, ...] - every real
    entry across every FanTeam product (football/golf/NFL) on this
    account. tournaments/@me, confirmed live - but only WITH the
    "bearer[white_label]=fanteam" query param. Without it this returns
    HTTP 401 {"error": "no_client"} even with a genuinely valid token
    (confirmed live: the exact same token, same header, only the query
    string different) - Scout Gaming's backend serves several white-label
    sites off one platform and apparently needs the product told apart
    explicitly for this particular "@me" (i.e. cross-tournament) endpoint,
    unlike the single-tournament endpoints (players/fixtures) this
    project already used successfully without it."""
    status, body = _http_json(
        f"{GAME_BASE}/tournaments/@me?bearer%5Bwhite_label%5D=fanteam", headers={"Authorization": f"Bearer {access_token}"}
    )
    if status != 200 or not body:
        raise RuntimeError(f"FanTeam tournaments/@me failed: HTTP {status}")
    return [
        {"fantasy_team_id": str(t["id"]), "tournament_id": str(t["tournamentId"])}
        for t in body.get("fantasyTeams", [])
    ]


def _flatten_shadow_text(page):
    """Every leaf-text node across the whole page AND every nested shadow
    root, in DOM order - the exact technique confirmed live against the
    real squad page (see module docstring). Returns a plain list[str]."""
    return page.evaluate(
        """
        () => {
          const out = [];
          function walk(root) {
            root.querySelectorAll('*').forEach(el => {
              if (el.shadowRoot) walk(el.shadowRoot);
              if (el.children.length === 0) {
                const t = (el.textContent || '').trim();
                if (t) out.push(t);
              }
            });
          }
          walk(document);
          return out;
        }
        """
    )


def _parse_squad_tokens(tokens):
    """tokens -> {"starting": [...], "bench": [...]}, each entry
    {"name", "team_short", "opponent_short", "price", "position", "is_captain", "is_vice_captain"}.
    Pure function, no I/O - unit-testable against the exact real token
    sequence captured live (see module docstring)."""
    import re

    price_re = re.compile(PRICE_RE)
    starting, bench = [], []
    current_group_players = []
    i = 0
    n = len(tokens)
    seen_group_break = False  # flips true once we've seen the 4th starting-XI group label
    groups_seen = 0
    while i < n:
        badge = None
        if tokens[i] in ("C", "VC"):
            badge = tokens[i]
            i += 1
        if i + 3 >= n or not price_re.match(tokens[i + 3]):
            # Not a player record after all (e.g. stray "C"/"VC" text
            # elsewhere on the page) - skip forward defensively rather
            # than raise, so an unrelated page element can never corrupt
            # the whole parse.
            i += 1
            continue
        name, team_short, opponent_short, price = tokens[i], tokens[i + 1], tokens[i + 2], tokens[i + 3]
        i += 4
        entry = {
            "name": name,
            "team_short": team_short,
            "opponent_short": opponent_short,
            "price": float(price[:-1]),
            "is_captain": badge == "C",
            "is_vice_captain": badge == "VC",
        }
        if not seen_group_break and i < n and tokens[i] in STARTING_SECTION_LABELS:
            entry["position"] = tokens[i]
            i += 1
            groups_seen += 1
            starting.append(entry)
            if groups_seen >= len(STARTING_SECTION_LABELS):
                seen_group_break = True
        elif not seen_group_break:
            entry["position"] = None  # filled in once its group's trailing label is read
            current_group_players.append(entry)
            starting.append(entry)
        elif i < n and tokens[i] in BENCH_POSITION_CODES:
            entry["position"] = tokens[i]
            i += 1
            bench.append(entry)
        else:
            # Past the starting XI but no bench code followed - squad
            # section is over (hit "MATCHES IN THE TOURNAMENT" or similar
            # trailing page content). Stop rather than misparse the rest
            # of the page as players.
            break
        if entry.get("position") and current_group_players:
            for p in current_group_players:
                if p["position"] is None:
                    p["position"] = entry["position"]
            current_group_players = []
    return {"starting": starting, "bench": bench}


def fetch_squad(playwright, access_token, tournament_id, fantasy_team_id):
    """Real squad for one team - launches a fresh headless browser,
    injects the real access token FanTeam's own app reads from
    localStorage (see scraper_fanteam.py's get_ft_token/AUTH_STATE_FILE
    for the same key name), navigates to the edit URL, and parses the
    rendered squad via _flatten_shadow_text + _parse_squad_tokens.
    Returns _parse_squad_tokens' shape, or raises if the page doesn't
    render a recognisable squad (fails loud, never returns a silently
    wrong/partial squad)."""
    browser = playwright.chromium.launch(headless=True)
    try:
        context = browser.new_context()
        page = context.new_page()
        page.goto("https://www.fanteam.com/", wait_until="domcontentloaded")
        page.evaluate("(t) => localStorage.setItem('ftToken', t)", access_token)
        page.goto(EDIT_URL_TEMPLATE.format(tournament_id=tournament_id, team_id=fantasy_team_id), wait_until="networkidle")
        page.wait_for_timeout(2000)
        tokens = _flatten_shadow_text(page)
        squad = _parse_squad_tokens(tokens)
        if len(squad["starting"]) < 5:  # a real squad is 11-15 players; a login/error page never is
            raise RuntimeError(
                f"FanTeam squad page for team {fantasy_team_id} didn't render a recognisable squad "
                f"(parsed {len(squad['starting'])} starting players) - session may be invalid or the page layout changed."
            )
        return squad
    finally:
        browser.close()
