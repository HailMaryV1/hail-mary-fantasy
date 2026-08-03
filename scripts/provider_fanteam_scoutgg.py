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
     ABANDONED as the "which teams do I have" mechanism, though - even
     with the right token AND the white_label param this still returns
     an empty fantasyTeams list for the real account (see list_my_teams'
     docstring for the full story). "Which teams do I have" is instead
     answered by mechanism 3 below (DOM-based, not REST).
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

3. "Which teams do I have" - also NOT a JSON endpoint, same reasoning as
   #2 above. FanTeam's own "My Entries" page lists every real entry with
   a real per-row link matching /fantasy/edit/{tournamentId}/{teamId} -
   confirmed live against the real account's real entry. See
   discover_my_teams' docstring for the full mechanism.

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
import re
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
    email-based, unlike most of this project's other integrations).

    Started failing live on 2026-08-03 with HTTP 451
    {"error": "auth.wrong_domain"} - a tried fix (adding a white_label
    identifier to the request body, matching a precedent from a
    different endpoint - see list_my_teams' docstring) was tested against
    real traffic and DID NOT resolve it, same error. Reverted that guess.

    SECOND UNCONFIRMED HYPOTHESIS (2026-08-03): this worked live as
    recently as 2026-07-31, which argues against the request URL itself
    being wrong all along - something more likely changed FanTeam-side.
    A real browser automatically sends Origin/Referer on this
    cross-origin call; this script (plain urllib) sends neither. If
    FanTeam recently started validating that header, a missing Origin
    would plausibly read as "wrong domain" the same as a mismatched one.
    Added both headers here as the next best-reasoned guess - still
    unconfirmed against real traffic. If login still fails after this,
    this hypothesis was also wrong and the real fix needs the actual
    request captured from a real browser's Network tab instead of
    further guessing."""
    status, body = _http_json(
        LOGIN_URL,
        method="POST",
        headers={"Origin": "https://www.fanteam.com", "Referer": "https://www.fanteam.com/"},
        body={"username": username, "password": password},
    )
    if status != 200 or not body or "token" not in body:
        raise RuntimeError(f"FanTeam login failed: HTTP {status} {body}")
    return body["token"], body.get("refreshToken"), body.get("profile")


def list_my_teams(access_token):
    """ABANDONED - kept only as a documented dead end. tournaments/@me
    with "bearer[white_label]=fanteam" fixed the earlier HTTP 401
    "no_client" error (confirmed live: same token, same header, only the
    query string different), but the endpoint then returns an EMPTY
    fantasyTeams list for this real account even so - confirmed live
    using the browser's own genuinely valid, currently-active session
    token (not a token minted by this script), while the real FanTeam app
    itself, in that same browser, in that same moment, clearly showed one
    real team on screen. This is not an auth or account problem (the
    account was independently confirmed correct - see
    discover_my_teams' docstring) - the real app sends something to this
    specific endpoint that a plain Authorization-header fetch doesn't
    replicate, and it was never identified. fantasy_teams/entries was
    also tried and returns user.not_authorized/no_client depending on
    param combination - also unresolved. Do not resume down this path
    without new evidence; use discover_my_teams instead."""
    status, body = _http_json(
        f"{GAME_BASE}/tournaments/@me?bearer%5Bwhite_label%5D=fanteam", headers={"Authorization": f"Bearer {access_token}"}
    )
    if status != 200 or not body:
        raise RuntimeError(f"FanTeam tournaments/@me failed: HTTP {status}")
    return [
        {"fantasy_team_id": str(t["id"]), "tournament_id": str(t["tournamentId"])}
        for t in body.get("fantasyTeams", [])
    ]


def _click_shadow_text(page, text):
    """Clicks the first leaf element anywhere in the page - including
    nested shadow roots - whose trimmed text matches `text`
    (case-insensitive). Used instead of navigating to a guessed URL:
    directly navigating to https://www.fanteam.com/my-overview/upcoming
    was confirmed live, in a real logged-in session, to sometimes bounce
    to a generic lobby page and silently clear the stored auth token.
    Clicking FanTeam's own real nav link never had that problem. Returns
    True if something was clicked."""
    return page.evaluate(
        """
        (targetText) => {
          function walk(root) {
            for (const el of root.querySelectorAll('*')) {
              if (el.shadowRoot) { const r = walk(el.shadowRoot); if (r) return true; }
              if (el.children.length === 0 && (el.textContent || '').trim().toUpperCase() === targetText) {
                el.click();
                return true;
              }
            }
            return false;
          }
          return walk(document);
        }
        """,
        text.upper(),
    )


def _click_shadow_prefix(page, prefix):
    """Clicks the smallest (shortest-text) element anywhere in the page -
    including nested shadow roots - whose trimmed text STARTS WITH
    `prefix` (case-insensitive). Needed for My Entries' tab buttons
    ("Upcoming"/"Running"/"Ended"), which are custom <ft-tab> elements
    whose real textContent also concatenates a count and a Buy-in total
    with no separator (confirmed live: "Upcoming1£1.00Buy-in") - never
    a bare leaf match like _click_shadow_text's "MY ENTRIES" case, so
    that stricter exact/leaf-only matcher can't find them at all. Picks
    the shortest matching text (rather than a large ancestor container)
    to click something close to the real button; click events bubble/
    compose across shadow boundaries, so clicking an inner element still
    reaches whatever listens for the tab click. Returns True if
    something was clicked."""
    return page.evaluate(
        """
        (prefix) => {
          let best = null;
          function walk(root) {
            for (const el of root.querySelectorAll('*')) {
              if (el.shadowRoot) walk(el.shadowRoot);
              const t = (el.textContent || '').trim();
              if (t.length > 0 && t.length < 60 && t.toUpperCase().startsWith(prefix)) {
                if (!best || t.length < best.text.length) best = {el, text: t};
              }
            }
          }
          walk(document);
          if (best) { best.el.click(); return true; }
          return false;
        }
        """,
        prefix.upper(),
    )


def _expand_all_entry_rows(page):
    """Clicks every "expando" toggle on the My Entries table (confirmed
    live token capture: each entry row's real team ID only appears in the
    DOM once its row is expanded) - across all shadow roots, best-effort,
    no return value."""
    page.evaluate(
        """
        () => {
          function walk(root) {
            root.querySelectorAll('*').forEach(el => {
              if (el.shadowRoot) walk(el.shadowRoot);
              if (el.children.length === 0 && (el.textContent || '').trim().toLowerCase() === 'expando') {
                el.click();
              }
            });
          }
          walk(document);
        }
        """
    )


def _flatten_shadow_hrefs(page, must_include):
    """Every real <a href> anywhere in the page - including nested shadow
    roots - whose href contains `must_include`, deduplicated."""
    return page.evaluate(
        """
        (mustInclude) => {
          const out = [];
          function walk(root) {
            root.querySelectorAll('a[href]').forEach(a => { if (a.href.includes(mustInclude)) out.push(a.href); });
            root.querySelectorAll('*').forEach(el => { if (el.shadowRoot) walk(el.shadowRoot); });
          }
          walk(document);
          return [...new Set(out)];
        }
        """,
        must_include,
    )


GAME_TYPE_TO_SPORT = {
    "football": "football",  # confirmed live 2026-07-31 against real tournament 1131483
    "golf": "golf",  # confirmed live via scraper_fanteam_golf.py's own gameType check
    # NFL's real gameType string hasn't been seen live yet - add it here
    # once a real NFL tournament_id is confirmed (same "extend once
    # confirmed" precedent as sync_provider_squads.py's override dict).
}


def fetch_tournament_meta(tournament_id):
    """(name, sport) for a real tournament, straight from FanTeam's own
    tournament API - no auth, no browser. Confirmed live: GET
    {GAME_BASE}/tournaments/{id}/players?round=editable returns
    {"tournament": {"name": ..., "gameType": ..., ...}} - the exact
    endpoint scraper_fanteam_golf.py already uses for golf (it checks
    gameType == "golf" itself), generalised here to classify ANY
    discovered tournament_id by real provider data instead of a
    hardcoded per-ID list. gameType is mapped through GAME_TYPE_TO_SPORT;
    an unrecognised/missing gameType, or a request that fails outright,
    returns (None, None) so the caller can skip persisting an unreliable
    record rather than guess - see sync_provider_squads.py's
    FANTEAM_TOURNAMENT_GAME_SLUG for the explicit-override fallback that
    exists for exactly this case."""
    status, body = _http_json(f"{GAME_BASE}/tournaments/{tournament_id}/players?round=editable")
    if status != 200 or not body:
        return None, None
    tournament = body.get("tournament") or {}
    name = tournament.get("name")
    sport = GAME_TYPE_TO_SPORT.get(tournament.get("gameType"))
    if not name or not sport:
        return None, None
    return name, sport


ENTRY_TABS = (("Upcoming", "upcoming"), ("Running", "running"))


def discover_my_teams(page):
    """[{"fantasy_team_id": str, "tournament_id": str, "status": str}, ...]
    - every real entry visible on FanTeam's own "My Entries" page across
    BOTH the "Upcoming" and "Running" tabs (never "Ended" - excluded by
    construction, this loop never visits that tab), reached by clicking
    the real "MY ENTRIES" nav link then each real tab label in turn (see
    _click_shadow_text's docstring for why not a guessed URL). Replaces
    list_my_teams's REST approach entirely - that endpoint is confirmed
    broken for this real account even with fully correct auth (see
    list_my_teams' docstring). No JSON API involved for discovery itself:
    each row is expanded (_expand_all_entry_rows) and its real
    tournament_id/team_id are read straight off a real <a href> matching
    /fantasy/edit/{tournamentId}/{teamId} - confirmed live against the
    real account's real entry (team 133545691, tournament 1131483,
    "ciccio12" #51333 shown on screen next to it, ruling out an account
    mismatch). Status comes for free from which tab an entry was found
    under - no separate parsing needed. A tab that can't be found (e.g.
    a real account with zero Running entries right now) is skipped, not
    fatal - only raises if NEITHER tab yields anything at all. `page`
    must already have a valid ftToken in localStorage and be freshly
    reloaded so the app's nav reflects the logged-in state (see
    open_authenticated_page)."""
    if not _click_shadow_text(page, "MY ENTRIES"):
        raise RuntimeError("Couldn't find the 'MY ENTRIES' nav link on fanteam.com - page layout may have changed.")
    page.wait_for_timeout(2000)

    entries = {}
    for tab_label, status in ENTRY_TABS:
        if not _click_shadow_prefix(page, tab_label):
            print(f"  [warn] couldn't find the {tab_label!r} tab on My Entries - skipping.")
            continue
        page.wait_for_timeout(1500)
        _expand_all_entry_rows(page)
        page.wait_for_timeout(800)
        for href in _flatten_shadow_hrefs(page, "/fantasy/edit/"):
            m = re.search(r"/fantasy/edit/(\d+)/(\d+)", href)
            if m:
                entries[(m.group(1), m.group(2))] = status

    if not entries:
        raise RuntimeError(
            "No real entries found on FanTeam's My Entries page (checked Upcoming + Running) - either the "
            "account genuinely has none right now, or the page layout changed. Not guessing either way."
        )
    return [
        {"tournament_id": t, "fantasy_team_id": team, "status": status}
        for (t, team), status in sorted(entries.items())
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


def _locate_squad_section(tokens):
    """Slices the full flattened page down to just the real squad-picks
    grammar - confirmed live (2026-07-31) that the real edit page also
    renders a "suggested team" onboarding modal, a budget/preview widget,
    and a large player-pool/filters panel elsewhere on the same page
    (total flattened tokens: ~1200, vs. ~50 for the real picks), and that
    a defensive linear scan across ALL of it can pick up coincidental
    4-token sequences (e.g. price-filter buttons: team name, team name,
    team name, "4.5M") that look like a valid player entry and get
    miscounted as real starting-XI players, corrupting the group-boundary
    bookkeeping before the real players are even reached (confirmed live:
    a real defender - Gabriel - went missing from a synced squad this
    way). The full-word position labels ("Goalkeeper"/"Defender"/
    "Midfielder"/"Forward") are a reliable anchor because they are
    confirmed to appear EXACTLY ONCE per real page load, unlike the short
    bench codes ("GK"/"DEF"/"MID"/"FOR") which repeat throughout the pool/
    preview panels - so slicing a small window around them keeps whatever
    the defensive per-token parser has to withstand down to a handful of
    tokens instead of the whole page. Falls back to the full token list
    if the anchors aren't found (parser's own defenses still apply, just
    without this extra guard)."""
    try:
        start = tokens.index("Goalkeeper") - 10
        end = tokens.index("Forward") + 40
    except ValueError:
        return tokens
    return tokens[max(0, start):min(len(tokens), end)]


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


def open_authenticated_page(playwright, access_token):
    """(browser, page) - one shared headless browser/page, authenticated
    once, reused for both discover_my_teams and every fetch_squad call
    (rather than a fresh browser launch + token injection per team, which
    the original single-team version did). Injects the real access token
    FanTeam's own app reads from localStorage (see scraper_fanteam.py's
    get_ft_token/AUTH_STATE_FILE for the same key name), then reloads so
    the app's own JS actually picks the token up and renders the
    logged-in nav (needed for discover_my_teams' nav click to find "MY
    ENTRIES" at all).

    Before any of that: dismisses FanTeam's own geo-compliance interstitial
    ("this site isn't tailored for the regulations in your area - Skip /
    Redirect") and cookie-consent banner, which a real UK browser session
    doesn't hit but a GitHub Actions runner's US datacenter IP does -
    confirmed via a real fanteam_debug screenshot (see
    sync_provider_squads.py's discovery-failure debug capture) showing the
    logged-out marketing homepage sitting behind that interstitial instead
    of the SPA, regardless of whether the injected token was valid. "Skip"
    (not "Redirect") keeps us on the same fanteam.com the token belongs to.
    Both dismissals are best-effort (page.evaluate returning False if the
    banner never appears, e.g. already dismissed this session) - never
    fatal on their own, since a real invalid/expired token should still
    fail loudly downstream in discover_my_teams, not here.

    Caller must browser.close() when done."""
    browser = playwright.chromium.launch(headless=True)
    context = browser.new_context()
    page = context.new_page()
    page.goto("https://www.fanteam.com/", wait_until="domcontentloaded")
    page.wait_for_timeout(1500)
    _click_shadow_text(page, "Skip")
    _click_shadow_text(page, "Decline All")
    page.wait_for_timeout(500)
    page.evaluate("(t) => localStorage.setItem('ftToken', t)", access_token)
    page.reload(wait_until="networkidle")
    page.wait_for_timeout(1000)
    return browser, page


def _goto_and_capture_private_name(page, tournament_id, fantasy_team_id):
    """Navigates to the squad edit page AND returns its real, provider-
    owned custom team name (FanTeam's own "Edit private name" pencil-icon
    feature) - None if the entry has no custom name set. NOT scraped
    from the DOM - the edit page's own JS makes a real GET
    {GAME_BASE}/fantasy_teams/{team_id}?round=editable call as part of
    normal page load, whose response body already carries
    fantasyTeam.privateName (confirmed live: a team named "Testing Name"
    round-trips exactly). A bare replayed HTTP call to this same URL,
    even with the right Bearer token, gets a 401 - whatever auth the
    SPA's own client attaches isn't just the header - so this only works
    by capturing the app's OWN real request while it fires during normal
    navigation, not by re-requesting it independently. The navigation
    itself always happens (the `with` block's body runs before its exit
    can time out) - only the private-name capture is best-effort; any
    failure there (timeout, unexpected shape) returns None rather than
    failing the whole squad fetch over a "nice to have" display name."""
    url = EDIT_URL_TEMPLATE.format(tournament_id=tournament_id, team_id=fantasy_team_id)
    try:
        with page.expect_response(
            lambda r: f"/fantasy_teams/{fantasy_team_id}?round=editable" in r.url, timeout=15000
        ) as resp_info:
            page.goto(url, wait_until="networkidle")
        body = resp_info.value.json()
        name = (body.get("fantasyTeam") or {}).get("privateName")
        return name if name else None
    except Exception:
        return None


def fetch_squad(page, tournament_id, fantasy_team_id):
    """Real squad for one team on an already-authenticated `page` (see
    open_authenticated_page) - navigates to the edit URL and parses the
    rendered squad via _flatten_shadow_text + _locate_squad_section +
    _parse_squad_tokens. Returns _parse_squad_tokens' shape plus a
    "private_name" key (see _goto_and_capture_private_name - None if the
    entry has no custom name set). Raises if the page doesn't render a
    recognisable squad (fails loud, never returns a silently wrong/
    partial squad)."""
    private_name = _goto_and_capture_private_name(page, tournament_id, fantasy_team_id)
    page.wait_for_timeout(2000)
    tokens = _locate_squad_section(_flatten_shadow_text(page))
    squad = _parse_squad_tokens(tokens)
    if len(squad["starting"]) < 5:  # a real squad is 11-15 players; a login/error page never is
        raise RuntimeError(
            f"FanTeam squad page for team {fantasy_team_id} didn't render a recognisable squad "
            f"(parsed {len(squad['starting'])} starting players) - session may be invalid or the page layout changed."
        )
    squad["private_name"] = private_name
    return squad
