"""
provider_cloudff.py
---------------------
Auto Import My Squad - Cloud Fantasy Football (cloud-ff.co.uk) provider
adapter. Much simpler than FanTeam's: everything here is a real, direct
JSON API - no Shadow DOM, no browser automation needed at all.

Two real mechanisms, confirmed live 2026-07-31 against the real account
(team_id 1569, "CloudNine"):

1. Login - a plain JSON REST call.
     POST https://europe-west2-cloudfantasy-449312.cloudfunctions.net/login
       {"email": ..., "password": ...}
     confirmed live via a real captured request (discover_cloudff.py,
     field names only - see its redact_body). Issues a JWT - confirmed
     live via structural decode of the token this project already had
     stored: header {alg, typ}, payload {user_id, username, team_id,
     email, iat, exp}, iat/exp exactly 14 days apart.

   The login RESPONSE's own JSON field name for the token was never
   captured live (it fell through two separate discovery runs' content-
   type filter) - rather than guess a field name, login() below searches
   the parsed response for ANY string value that decodes as a
   well-formed 3-segment JWT carrying the expected claims, and fails
   loudly if none is found. This also means Cloud FF needs no separate
   "which team do I have" call at all, unlike FanTeam - team_id is a
   claim on the token itself.

   No distinct refresh-token endpoint exists (only one token is ever
   stored client-side, under localStorage key "authToken") - but unlike
   FanTeam's ~3h token, this one is confirmed live to last a full 14
   days, so sync_provider_squads.py's sync_cloudff reuses the stored
   access token across many sync cycles and only re-logs-in (via the
   stored encrypted password) once it's actually close to expiry - much
   closer to a real refresh-token cadence than FanTeam's forced-relogin-
   every-run, even without a dedicated refresh endpoint.

2. Reading the real squad - also a plain JSON REST call, authenticated.
     POST https://europe-west2-cloudfantasy-449312.cloudfunctions.net/getUserTeam
       {"team_id": ..., "curgw": <gameweek>}
       (Authorization: Bearer <token> - confirmed live via a direct A/B
       test: the same token as a raw header or missing entirely both got
       a real 401 "Missing or invalid token"; only "Bearer <token>"
       succeeded)
     -> {"team_data": {"current_team": {"GK": [{"PlayerID": ...}],
                                          "DEF": [...], "MID": [...], "FOR": [...]}}}
     Confirmed live: real numeric PlayerIDs, directly matching
     getPlayerList's own "id" field (already imported as
     game_players.external_id by import_cloudff.py) - no name-matching
     or DOM parsing involved at all, unlike FanTeam.

   Confirmed live against the FULL, untruncated real response: there is
   NO captain/vice-captain field anywhere in it, and no separate bench -
   Cloud FF's real team is just one flat list of PlayerIDs grouped by
   position (11 total for this account: 1 GK + 4 DEF + 4 MID + 2 FOR).
   The position breakdown itself IS the formation - preserved naturally
   by importing each player's own real position, no separate formation
   field exists to capture. Do not invent a captain here - this was
   checked against the real, live, full response, not assumed from a
   truncated preview.

Not a standalone script - imported by scripts/sync_provider_squads.py.
"""
import base64
import json
import urllib.error
import urllib.request

LOGIN_URL = "https://europe-west2-cloudfantasy-449312.cloudfunctions.net/login"
GET_USER_TEAM_URL = "https://europe-west2-cloudfantasy-449312.cloudfunctions.net/getUserTeam"

POSITION_GROUPS = ("GK", "DEF", "MID", "FOR")


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


def _b64url_decode(segment):
    return base64.urlsafe_b64decode(segment + "=" * (-len(segment) % 4))


def _find_jwt(obj):
    """Recursively searches a parsed JSON response for the first string
    value that decodes as a well-formed 3-segment JWT carrying Cloud
    FF's real claim shape (user_id + team_id, confirmed live via a
    structural decode of a real token this project already had stored) -
    used instead of a guessed response field name (the real login
    response was never captured live - see module docstring). Returns
    (token, claims) or None."""
    if isinstance(obj, str):
        parts = obj.split(".")
        if len(parts) == 3:
            try:
                claims = json.loads(_b64url_decode(parts[1]))
            except Exception:
                return None
            if "team_id" in claims and "user_id" in claims:
                return obj, claims
        return None
    if isinstance(obj, dict):
        for v in obj.values():
            found = _find_jwt(v)
            if found:
                return found
    if isinstance(obj, list):
        for v in obj:
            found = _find_jwt(v)
            if found:
                return found
    return None


def login(email, password):
    """(access_token, claims) or raises. claims includes "team_id" -
    Cloud FF needs no separate "which team do I have" call at all, the
    token itself carries it (confirmed live)."""
    status, body = _http_json(LOGIN_URL, method="POST", body={"email": email, "password": password})
    if status != 200 or not body:
        raise RuntimeError(f"Cloud FF login failed: HTTP {status} {body}")
    found = _find_jwt(body)
    if not found:
        raise RuntimeError(f"Cloud FF login succeeded but no recognisable auth token was found in the response: {body}")
    return found


def fetch_squad(access_token, team_id, gameweek):
    """{"GK": [player_id, ...], "DEF": [...], "MID": [...], "FOR": [...]}
    - real numeric Cloud FF PlayerIDs, straight off the real API, no
    parsing/matching involved (see module docstring). Raises if the
    response doesn't look like a real squad."""
    status, body = _http_json(
        GET_USER_TEAM_URL, method="POST", body={"team_id": team_id, "curgw": gameweek},
        headers={"Authorization": f"Bearer {access_token}"},
    )
    if status != 200 or not body or not body.get("success"):
        raise RuntimeError(f"Cloud FF getUserTeam failed: HTTP {status} {body}")
    current_team = body.get("team_data", {}).get("current_team", {})
    squad = {pos: [p["PlayerID"] for p in current_team.get(pos, [])] for pos in POSITION_GROUPS}
    total = sum(len(v) for v in squad.values())
    if total < 5:  # a real squad is 10-11 players; an empty/broken response never is
        raise RuntimeError(f"Cloud FF squad for team {team_id} didn't look like a real squad ({total} players): {body}")
    return squad
