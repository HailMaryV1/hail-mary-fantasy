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

    GET https://europe-west2-cloudfantasy-449312.cloudfunctions.net/getPlayerStats?startGW=1&endGW=1000
        -> [{"id", "TotalPoints", "TotalSavesPts", "TotalTacklePts",
             "TotalAccuratePassPts", "TotalOnTargetScoringAttPts",
             "TotalGoals", "TotalAssists", "TotalOwnGoals",
             "TotalMissedPenalties", "TotalMinutesPlayed",
             "TotalGoalsConceded", "TotalPenaltySaves", "TotalCleanSheets",
             "TotalSaves", "TotalTackles", "TotalAccuratePasses",
             "TotalOnTargetAttempts", "TotalYellowCards", "TotalRedCards",
             "TotalStartingXI", "TotalSubs", "Ownership", ...}, ...]
        This is Cloud FF's real "Bonus Points System" - the SavePts/
        TklPts/PassPts/SOTPts tiers cloud-ff.co.uk/stats displays per
        player, already pre-tiered into point totals by Cloud FF's own
        backend (not raw counts needing a step-function on our side).
        Confirmed live, unauthenticated, season-cumulative with
        startGW=1&endGW=1000. Also confirmed to genuinely support
        narrower windows (?startGW=5&endGW=5 returns real single-
        gameweek totals, not the season total truncated) - see
        scripts/capture_gameweek_actuals.py for the per-gameweek pull
        this same endpoint feeds.

No login needed for any of these - matches the pattern already established
for FanTeam's own player-pool pull (scraper_fanteam.py).

RUN:
    python3 scraper_cloudff.py
"""
import json
import time
import urllib.error
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parent

PLAYER_LIST_URL = "https://europe-west2-cloudfantasy-449312.cloudfunctions.net/getPlayerList"
FIXTURES_URL = "https://storage.googleapis.com/cloudfixtures/fixtures.json"
PLAYER_STATS_URL = "https://europe-west2-cloudfantasy-449312.cloudfunctions.net/getPlayerStats?startGW=1&endGW=1000"


def fetch_json(url, retries=3, backoff_seconds=5):
    # Retries a transient network blip (URLError/TimeoutError, including
    # a plain socket timeout) a few times before giving up for real -
    # same fix already proven for scraper_fanteam.py's own fetch_json,
    # applied here since this script runs unattended on the same
    # automated schedule.
    req = urllib.request.Request(url, headers={"User-Agent": "Mozilla/5.0"})
    last_error = None
    for attempt in range(1, retries + 1):
        try:
            with urllib.request.urlopen(req, timeout=30) as resp:
                return json.loads(resp.read())
        except (urllib.error.URLError, TimeoutError) as e:
            last_error = e
            if attempt < retries:
                print(f"  [retry] {url}: attempt {attempt}/{retries} failed ({e}) - retrying in {backoff_seconds}s ...")
                time.sleep(backoff_seconds)
    raise last_error


def main():
    players = fetch_json(PLAYER_LIST_URL)
    (ROOT / "cloudff_players_raw.json").write_text(json.dumps(players, indent=2))
    print(f"Saved {len(players)} real players to cloudff_players_raw.json")

    fixtures = fetch_json(FIXTURES_URL)
    (ROOT / "cloudff_fixtures_raw.json").write_text(json.dumps(fixtures, indent=2))
    print(f"Saved {len(fixtures)} real fixtures to cloudff_fixtures_raw.json")

    player_stats = fetch_json(PLAYER_STATS_URL)
    (ROOT / "cloudff_player_stats_raw.json").write_text(json.dumps(player_stats, indent=2))
    print(f"Saved {len(player_stats)} real player stat totals to cloudff_player_stats_raw.json")


if __name__ == "__main__":
    main()
