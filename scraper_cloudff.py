"""
scraper_cloudff.py
--------------------
Pulls Cloud Fantasy Football's (cloud-ff.co.uk) real reference data -
both endpoints are confirmed live, unauthenticated JSON:

    GET https://europe-west2-cloudfantasy-449312.cloudfunctions.net/getPlayerList
        -> [{"id", "last_name", "position" (1=GK/2=DEF/3=MID/4=FWD),
             "team_id" (Cloud FF's own numbering, not used - short_name
             is the join key instead), "short_name", "price", "status"
             ("a"/"i"/"d"/"s"/"u"), "news", "TotalPoints", ...}, ...]
        Confirmed live: 558 real players, all 20 real EPL clubs.

    GET https://storage.googleapis.com/cloudfixtures/fixtures.json
        -> [{"id", "kickoff_time", "event" (gameweek 1-41), "team_h_id",
             "team_h_name", "team_h_short", "team_h_score", "team_a_id",
             "team_a_name", "team_a_short", "team_a_score"}, ...]
        Confirmed live: 380 real fixtures (the full 2026/27 EPL season),
        and its own team_h_short/team_a_short + team_h_name/team_a_name
        pairs are the authoritative source for Cloud FF's own team-code
        vocabulary - reused directly by import_cloudff.py rather than a
        separately-guessed mapping.

No login needed for either - matches the pattern already established for
FanTeam's own player-pool pull (scraper_fanteam.py).

RUN:
    python3 scraper_cloudff.py
"""
import json
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parent

PLAYER_LIST_URL = "https://europe-west2-cloudfantasy-449312.cloudfunctions.net/getPlayerList"
FIXTURES_URL = "https://storage.googleapis.com/cloudfixtures/fixtures.json"


def fetch_json(url):
    req = urllib.request.Request(url, headers={"User-Agent": "Mozilla/5.0"})
    with urllib.request.urlopen(req, timeout=30) as resp:
        return json.loads(resp.read())


def main():
    players = fetch_json(PLAYER_LIST_URL)
    (ROOT / "cloudff_players_raw.json").write_text(json.dumps(players, indent=2))
    print(f"Saved {len(players)} real players to cloudff_players_raw.json")

    fixtures = fetch_json(FIXTURES_URL)
    (ROOT / "cloudff_fixtures_raw.json").write_text(json.dumps(fixtures, indent=2))
    print(f"Saved {len(fixtures)} real fixtures to cloudff_fixtures_raw.json")


if __name__ == "__main__":
    main()
