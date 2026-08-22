"""
scraper_dreamteam_stats.py
----------------------------
Pulls Dream Team's real per-player SEASON-CUMULATIVE stats - confirmed
live, unauthenticated JSON, a sibling of scraper_dreamteam.py's own
/api/players endpoint on the same backend:

    GET https://engagecraft-fantasy-backend-prod.azurewebsites.net/api/players/stats?limit=100&page=N
        -> {"success": true, "data": {"items": [
             {"playerId" (uuid - confirmed live to be the SAME uuid space
              as /api/players' own "id", already written to
              game_players.external_id by import_dreamteam.py - no name-
              matching needed, unlike every other provider integration in
              this project), "position", "totalPoints", "averagePoints",
              "matchdayPoints" (most recent single gameweek's points),
              "goals", "assists", "shotsOnTarget", "chancesCreated",
              "tackles", "cleanSheet", "saves", "goalsConceded",
              "yellowCards", "redCards", "ownGoals", "penaltyMisses",
              "penaltySaves", plus the 12 raw Bonus Points PPM components
              (dribbles/crosses/offsides/interceptions/blocks/
              goalsOutsideArea/foulsWon/foulsMade/errorsLeadingToGoal/
              claims/punches/keeperSweeps) and passCompletionRate, ...},
             ...]}}
        Confirmed live 2026-08-22: 536 real players across 6 pages
        (limit=100, page=1..6, page 7 returns an empty items list -
        that's the real termination signal, no total-count field exists
        in the envelope). offset/skip/start params are silently ignored
        no-ops - only page actually paginates.

    totalPoints is real-time SEASON-cumulative (confirmed by the presence
    of a SEPARATE matchdayPoints field carrying just the latest gameweek
    - same "totalPoints = season, matchdayPoints/lastPoints = one
    gameweek" shape as every other provider in this project), so this
    script is meant to be re-run every refresh cycle, same as
    scraper_cloudff.py's own getPlayerStats pull - see
    scripts/seed_dreamteam_historical_stats.py, which reads this file's
    output and re-seeds Dream Team's historical shrinkage prior from it
    every run (replacing the one-time stale CSV seed
    (import_historical_data.py, no longer in this repo) that used to be
    the only source for Dream Team's PT1/PT60/PT90 involvement rates).

    No real minutes-played or starts/appearances COUNT field exists
    anywhere in this endpoint's real response (52 keys inspected live,
    none of them minutes/starts/appearances) - a genuine, permanent
    upstream data gap, same class as FanTeam's missing per-gameweek
    minutes field. seed_dreamteam_historical_stats.py derives an honest
    games_played proxy from totalPoints/averagePoints instead - see that
    script's own docstring for the full reasoning.

    Known live bug in Dream Team's own API (not ours): accented names
    (e.g. "Martin Ødegaard") come through double-mojibake-encoded
    ("Martin Ã˜degaard"). Harmless here - this script never
    reads/writes any name field, matching solely on playerId - but noted
    for anyone tempted to display firstName/lastName from this endpoint
    directly.

RUN:
    python3 scraper_dreamteam_stats.py
"""
import json
import time
import urllib.error
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parent

STATS_URL = "https://engagecraft-fantasy-backend-prod.azurewebsites.net/api/players/stats"
PAGE_LIMIT = 100


def fetch_json(url, retries=3, backoff_seconds=5):
    # Same transient-blip retry already proven for scraper_dreamteam.py's
    # own fetch_json - this script runs unattended on the same schedule.
    req = urllib.request.Request(url, headers={"User-Agent": "Mozilla/5.0", "Accept": "application/json"})
    last_error = None
    for attempt in range(1, retries + 1):
        try:
            with urllib.request.urlopen(req, timeout=30) as resp:
                return json.loads(resp.read().decode("utf-8"))
        except (urllib.error.URLError, TimeoutError) as e:
            last_error = e
            if attempt < retries:
                print(f"  [retry] {url}: attempt {attempt}/{retries} failed ({e}) - retrying in {backoff_seconds}s ...")
                time.sleep(backoff_seconds)
    raise last_error


def main():
    all_items = []
    page = 1
    while True:
        body = fetch_json(f"{STATS_URL}?limit={PAGE_LIMIT}&page={page}")
        if not body.get("success"):
            raise SystemExit(f"Dream Team player-stats endpoint returned success=false on page {page}: {body}")
        items = body["data"]["items"]
        if not items:
            break
        all_items.extend(items)
        page += 1

    (ROOT / "dreamteam_player_stats_raw.json").write_text(json.dumps(all_items, indent=2, ensure_ascii=False), encoding="utf-8")
    print(f"Saved {len(all_items)} real player-stats rows to dreamteam_player_stats_raw.json ({page - 1} page(s)).")


if __name__ == "__main__":
    main()
