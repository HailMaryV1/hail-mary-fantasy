"""
scraper_eflfantasy.py
----------------------
Pulls the EFL's official fantasy game's (fantasy.efl.com) real reference
data - all four endpoints are confirmed live, unauthenticated JSON (no
login/reCAPTCHA dance needed at all, unlike FanTeam's scraper):

    GET https://fantasy.efl.com/json/fantasy/competitions.json
        -> [{"id", "code" ('CH'/'L1'/'L2'), "name"}, ...]
        Confirmed live: exactly 3 rows - Championship (10), League One
        (11), League Two (12). This is ONE combined fantasy game across
        all three divisions, not three separate games.

    GET https://fantasy.efl.com/json/fantasy/squads.json
        -> [{"id", "competitionId", "name", "shortName", "abbreviation",
             "darkBadge"/"lightBadge"/"jersey" urls, "totalPoints",
             "averagePoints", "percentSelected", "leaguePosition",
             "fdrHome"/"fdrAway" (fixture-difficulty, already computed by
             the platform itself), "last3Form", ...}, ...]
        Confirmed live: 72 real clubs (24 per division).

    GET https://fantasy.efl.com/json/fantasy/players.json
        -> [{"id", "squadId", "competitionId", "firstName", "lastName",
             "displayName", "position" ('GK'/'DEF'/'MID'/'FWD'), "status",
             "totalPoints", "averagePoints", "appearances", "goalsScored",
             "assists", "keyPasses", "shotsOnTarget", "cleanSheets",
             "clearances", "blocks", "tackles", "interceptions", "saves",
             "suspensionDetails", "injuryDetails"}, ...]
        Confirmed live: 3,386 real players. NO price/value field at all -
        this game has no budget system (see migration 0089's docstring).

    GET https://fantasy.efl.com/json/fantasy/rounds.json
        -> [{"id", "roundNumber", "name", "status", "lockoutDate",
             "games": [{"id", "competitionId", "date", "homeId", "awayId",
                        "homeScore", "awayScore", "status", "isFinalized"}, ...]},
            ...]
        Confirmed live: 42 real gameweeks spanning the full season, each
        with its own real fixture list across all 3 divisions.

RUN:
    python3 scraper_eflfantasy.py
"""
import gzip
import json
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parent
BASE = "https://fantasy.efl.com/json/fantasy"

ENDPOINTS = {
    "competitions": f"{BASE}/competitions.json",
    "squads": f"{BASE}/squads.json",
    "players": f"{BASE}/players.json",
    "rounds": f"{BASE}/rounds.json",
}


def fetch_json(url):
    # fantasy.efl.com gzips responses regardless of Accept-Encoding -
    # urllib doesn't auto-decompress, so this checks the magic bytes
    # rather than trusting Content-Encoding (confirmed live: the header
    # isn't always present even though the body is gzipped).
    req = urllib.request.Request(url, headers={"User-Agent": "Mozilla/5.0"})
    with urllib.request.urlopen(req, timeout=30) as resp:
        raw = resp.read()
    if raw[:2] == b"\x1f\x8b":
        raw = gzip.decompress(raw)
    return json.loads(raw)


def main():
    for name, url in ENDPOINTS.items():
        data = fetch_json(url)
        out_path = ROOT / f"eflfantasy_{name}_raw.json"
        out_path.write_text(json.dumps(data, indent=2), encoding="utf-8")
        print(f"Saved {len(data)} real {name} to {out_path.name}")


if __name__ == "__main__":
    main()
