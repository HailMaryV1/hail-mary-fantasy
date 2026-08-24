"""
import_foul_stats.py
--------------------
Historical per-player foul record from SportMonks, into player_foul_stats
(migration 0142). This is the input that lets /fouls hold an opinion of its own
instead of only auditing the bookmaker against itself.

WHY THIS SHAPE. SportMonks aggregates statistics per player per season, and
/squads/seasons/{season}/teams/{team} returns a whole squad - player id, name,
position, and the statistic details - in ONE call. Scraping the same numbers
per fixture would cost ~380 calls per league-season instead of ~20, for data
this model does not need at match granularity: it wants a rate per 90, and a
season total over known minutes is exactly that.

Statistic types used (confirmed live, not guessed):
    56  Fouls           - fouls the player committed
    96  Fouls Drawn     - fouls the player suffered
        Minutes Played, Appearances, Lineups

LEAGUE COMPETITIONS ONLY (8 Premier League, 9 Championship, 12 League One,
14 League Two). The cups this subscription also entitles are deliberately left
out: their season ids are separate, their samples are tiny, and they mix sides
from four divisions, so folding them in would blur the league baselines the
shrinkage depends on without adding much signal.

Squad rows for players who never featured carry no statistics at all; they are
skipped rather than written as zero-foul rows, which would drag every
positional baseline toward zero.

RUN:
    python3 scripts/import_foul_stats.py --dry-run      # report, write nothing
    python3 scripts/import_foul_stats.py                # apply
    python3 scripts/import_foul_stats.py --seasons 1    # current season only
"""

import argparse
import json
import os
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
from datetime import datetime, timezone
from pathlib import Path

import psycopg2
from psycopg2.extras import execute_values

ROOT = Path(__file__).resolve().parent.parent
SPORTMONKS_BASE = "https://api.sportmonks.com/v3/football"

# League competitions only - see module docstring for why the cups are out.
LEAGUES = {
    8: "Premier League",
    9: "Championship",
    12: "League One",
    14: "League Two",
}

FOULS_TYPE_ID = 56
FOULS_DRAWN_TYPE_ID = 96

# Statistic detail names that carry a plain {"total": n} payload.
WANTED_BY_NAME = {
    "Minutes Played": "minutes",
    "Appearances": "appearances",
    "Lineups": "lineups",
}

# Courtesy pause between calls. The full sweep is ~240 requests, which is well
# inside any sane rate limit, but a tight loop against someone else's API is
# rude and invites a 429 that costs more time than the pause.
SLEEP_SECONDS = 0.15


def load_env():
    env_path = ROOT / ".env"
    if not env_path.exists():
        return  # CI sets real env vars directly - no .env file there.
    for line in env_path.read_text(encoding="utf-8").splitlines():
        line = line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, _, value = line.partition("=")
        os.environ.setdefault(key.strip(), value.strip())


def fetch_json(url, retries=3, backoff_seconds=5):
    """
    Retry transient blips. Same reasoning as import_sportmonks_match_odds.py:
    a single slow response raises TimeoutError rather than HTTPError, which
    slipped past narrower except clauses there and killed a whole run.
    """
    req = urllib.request.Request(url, headers={"User-Agent": "Mozilla/5.0"})
    last_error = None
    for attempt in range(1, retries + 1):
        try:
            with urllib.request.urlopen(req, timeout=90) as response:
                return json.loads(response.read().decode("utf-8"))
        except Exception as exc:  # noqa: BLE001 - deliberately broad, see above
            last_error = exc
            if attempt < retries:
                time.sleep(backoff_seconds * attempt)
    raise RuntimeError(f"SportMonks request failed after {retries} attempts: {last_error}")


def api(path, **params):
    params["api_token"] = os.environ["SPORTMONKS_API_KEY"]
    url = f"{SPORTMONKS_BASE}{path}?{urllib.parse.urlencode(params)}"
    time.sleep(SLEEP_SECONDS)
    return fetch_json(url)


def seasons_for_league(league_id, keep):
    """Most recent `keep` seasons, newest last."""
    payload = api("/seasons", filters=f"seasonLeagues:{league_id}", per_page=50)
    rows = payload.get("data") or []
    rows.sort(key=lambda s: s.get("starting_at") or "")
    return rows[-keep:]


def stat_value(detail):
    """
    Squad statistic details carry their number under different keys depending on
    the type - a plain total for most, an in/out split for substitutions. Only
    the plain totals are wanted here, so anything else returns None rather than
    guessing which half of a split to use.
    """
    value = detail.get("value")
    if isinstance(value, dict):
        total = value.get("total")
        if isinstance(total, (int, float)):
            return int(total)
        return None
    if isinstance(value, (int, float)):
        return int(value)
    return None


def squad_rows(season, league_id, team_id, team_name):
    payload = api(
        f"/squads/seasons/{season['id']}/teams/{team_id}",
        include="player;details.type",
    )
    out = []
    for row in payload.get("data") or []:
        details = row.get("details") or []
        if not details:
            continue  # never featured - see docstring

        stats = {"fouls": None, "fouls_drawn": None, "minutes": 0, "appearances": 0, "lineups": 0}
        for detail in details:
            type_info = detail.get("type") or {}
            type_id = type_info.get("id")
            name = type_info.get("name")
            value = stat_value(detail)
            if value is None:
                continue
            if type_id == FOULS_TYPE_ID:
                stats["fouls"] = value
            elif type_id == FOULS_DRAWN_TYPE_ID:
                stats["fouls_drawn"] = value
            elif name in WANTED_BY_NAME:
                stats[WANTED_BY_NAME[name]] = value

        # Minutes are the denominator of every rate this feeds; a row without
        # them cannot be turned into a per-90 and is dropped rather than
        # written with a zero that would look like a real observation.
        if not stats["minutes"]:
            continue
        if stats["fouls"] is None and stats["fouls_drawn"] is None:
            continue

        player = row.get("player") or {}
        name = player.get("display_name") or player.get("name")
        if not name:
            continue

        out.append(
            (
                row.get("player_id"),
                team_id,
                season["id"],
                league_id,
                season.get("name"),
                name,
                row.get("position_id"),
                stats["minutes"],
                stats["appearances"],
                stats["lineups"],
                stats["fouls"] or 0,
                stats["fouls_drawn"] or 0,
            )
        )
    return out


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--dry-run", action="store_true", help="report only, write nothing")
    parser.add_argument("--seasons", type=int, default=3, help="how many recent seasons per league")
    parser.add_argument("--leagues", type=str, default="", help="comma-separated league ids to limit to")
    args = parser.parse_args()

    load_env()
    if not os.environ.get("SPORTMONKS_API_KEY"):
        sys.exit("SPORTMONKS_API_KEY is not set")

    league_ids = (
        [int(x) for x in args.leagues.split(",") if x.strip()] if args.leagues else list(LEAGUES)
    )

    collected = []
    calls = 0
    for league_id in league_ids:
        seasons = seasons_for_league(league_id, args.seasons)
        calls += 1
        print(f"\n{LEAGUES.get(league_id, league_id)}: {len(seasons)} season(s)")
        for season in seasons:
            teams = (api(f"/teams/seasons/{season['id']}", per_page=100).get("data") or [])
            calls += 1
            season_rows = []
            for team in teams:
                try:
                    season_rows += squad_rows(season, league_id, team["id"], team.get("name"))
                    calls += 1
                except Exception as exc:  # noqa: BLE001
                    print(f"    ! {team.get('name')}: {exc}")
            print(
                f"  {season.get('name')}: {len(teams)} teams -> {len(season_rows)} player-seasons with foul data"
            )
            collected += season_rows

    print(f"\n{len(collected)} rows collected across {calls} API calls")
    if not collected:
        sys.exit("nothing collected - refusing to touch the table")

    total_fouls = sum(r[10] for r in collected)
    total_drawn = sum(r[11] for r in collected)
    total_90s = sum(r[7] for r in collected) / 90.0
    print(
        f"  {total_fouls} fouls and {total_drawn} fouls drawn over {total_90s:.0f} full-match equivalents"
    )
    print(f"  league-wide rates: {total_fouls / total_90s:.3f} fouls/90, {total_drawn / total_90s:.3f} drawn/90")

    if args.dry_run:
        print("\n--dry-run: nothing written")
        return

    conn = psycopg2.connect(os.environ["DATABASE_URL"])
    conn.autocommit = False
    cur = conn.cursor()
    try:
        execute_values(
            cur,
            """
            insert into player_foul_stats (
                sportmonks_player_id, sportmonks_team_id, season_id, league_id,
                season_name, player_name, position_id, minutes, appearances,
                lineups, fouls, fouls_drawn
            ) values %s
            on conflict (sportmonks_player_id, season_id, sportmonks_team_id)
            do update set
                player_name = excluded.player_name,
                position_id = excluded.position_id,
                minutes = excluded.minutes,
                appearances = excluded.appearances,
                lineups = excluded.lineups,
                fouls = excluded.fouls,
                fouls_drawn = excluded.fouls_drawn,
                captured_at = now()
            """,
            collected,
            page_size=500,
        )
        conn.commit()
        print(f"\nwrote {len(collected)} rows at {datetime.now(timezone.utc).isoformat()}")
    except Exception:
        conn.rollback()
        raise
    finally:
        cur.close()
        conn.close()


if __name__ == "__main__":
    main()
