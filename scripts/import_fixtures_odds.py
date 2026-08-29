"""
import_fixtures_odds.py
------------------------
Pulls fixtures + match-winner (h2h) odds from The Odds API for every
competition configured in game_competitions, resolves team names
against the teams table (auto-creating teams we've never seen before -
cup fixtures pull in lower-league/European opponents the players/
game_players tables don't need to know about), and stores results in
fixtures / fixture_odds.

Competitions with no scheduled fixtures yet (e.g. Champions League
before the season's draw) simply return nothing - not an error.

Safe to re-run: fixtures are upserted by their Odds API event id.
fixture_odds are NOT upserted - each run appends a new snapshot per
bookmaker, so odds movement over time is preserved rather than
overwritten. Intended to run on a schedule (e.g. daily) once live.

2026-08-17: soccer_epl/soccer_fa_cup/soccer_england_efl_cup were
temporarily skipped here (SportMonks was the sole real-odds source for
them). 2026-08-29: SportMonks removed from this project entirely (see
import_dreamteamtonic_market_odds.py - real cost-saving replacement via
DreamTeamTonic/Spreadex) - this script's own insert_odds() call is
restored for all 3, since DreamTeamTonic doesn't cover FA Cup/Carabao
Cup at all yet (confirmed live) and leaving those with zero real-odds
coverage would be a real regression. Harmless overlap with DreamTeamTonic
for soccer_epl specifically (both write into the same "latest row wins"
tables) - redundant real sources are a feature here, not a conflict; see
that script's own docstring. Championship/League One/League Two were
never covered by The Odds API in the first place (both return HTTP 404
"Unknown sport" - confirmed live).

RUN:
    python3 scripts/import_fixtures_odds.py
"""

import json
import os
import sys
import time
import urllib.error
import urllib.request
from datetime import datetime
from pathlib import Path

import psycopg2

from activity_log import log_event

# European qualifier fixtures pull in team names with characters Windows'
# default console encoding (cp1252) can't print (e.g. FK Sabah, Slovan
# Bratislava) - crashed a real run mid-import. GitHub Actions' Linux
# runners default to UTF-8 already, but this makes it safe everywhere.
if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")

ROOT = Path(__file__).resolve().parent.parent
ODDS_BASE = "https://api.the-odds-api.com/v4"

# Known Odds API spellings that differ from our canonical team names.
# Discovered empirically - extend this if a competition surfaces a new
# team under a different spelling than what's already in `teams`,
# otherwise a duplicate team row gets created instead of matching the
# existing one.
ODDS_NAME_OVERRIDES = {
    "Brighton and Hove Albion": "Brighton",
}


def load_env():
    env_path = ROOT / ".env"
    if not env_path.exists():
        return  # CI sets real env vars directly - no .env file there.
    for line in env_path.read_text().splitlines():
        line = line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, _, value = line.partition("=")
        os.environ.setdefault(key.strip(), value.strip())


def season_for(kickoff: datetime) -> str:
    year = kickoff.year
    if kickoff.month >= 7:
        return f"{year}/{str(year + 1)[-2:]}"
    return f"{year - 1}/{str(year)[-2:]}"


def fetch_odds(competition, api_key, retries=3, backoff_seconds=5):
    # Retries a transient network blip (URLError/TimeoutError) a few
    # times before giving up on this one competition - same fix already
    # proven for scraper_fanteam.py's own fetch_json. A real HTTPError
    # (e.g. an unsupported sport_key returning 404) still fails
    # immediately, unchanged - retrying a permanent error just delays
    # the inevitable and wastes quota.
    url = f"{ODDS_BASE}/sports/{competition}/odds?apiKey={api_key}&regions=uk&markets=h2h"
    req = urllib.request.Request(url, headers={"User-Agent": "Mozilla/5.0"})
    for attempt in range(1, retries + 1):
        try:
            with urllib.request.urlopen(req, timeout=20) as resp:
                return json.loads(resp.read())
        except urllib.error.HTTPError as e:
            print(f"  [warn] {competition}: HTTP {e.code} - {e.read()[:200]}")
            return []
        except (urllib.error.URLError, TimeoutError) as e:
            if attempt < retries:
                print(f"  [retry] {competition}: attempt {attempt}/{retries} failed ({e}) - retrying in {backoff_seconds}s ...")
                time.sleep(backoff_seconds)
            else:
                print(f"  [warn] {competition}: gave up after {retries} attempts ({e})")
                return []


def resolve_team_id(cur, name):
    cur.execute(
        "select team_id from team_aliases where source = 'oddsapi' and external_name = %s",
        (name,),
    )
    row = cur.fetchone()
    if row:
        return row[0]

    canonical_name = ODDS_NAME_OVERRIDES.get(name, name)
    cur.execute("select id from teams where name = %s", (canonical_name,))
    row = cur.fetchone()
    if row:
        team_id = row[0]
    else:
        cur.execute("insert into teams (name) values (%s) returning id", (canonical_name,))
        team_id = cur.fetchone()[0]
        print(f"  [new team] {canonical_name}")

    cur.execute(
        "insert into team_aliases (team_id, source, external_name) values (%s, 'oddsapi', %s) on conflict do nothing",
        (team_id, name),
    )
    return team_id


def upsert_fixture(cur, external_id, competition, season, home_team_id, away_team_id, kickoff_at, home_name, away_name):
    # Checked before the upsert so we know whether this fixture is
    # genuinely new or just being refreshed, and whether its kickoff time
    # actually moved (a real reschedule) - the upsert itself is a blind
    # overwrite either way, this is purely for activity_log.
    cur.execute("select id, kickoff_at from fixtures where external_id = %s", (external_id,))
    existing = cur.fetchone()

    # Real bug found live 2026-08-27 (user report: "Charlton Athletic"
    # and "Luton" each showing up twice, 1-2 days apart, on the same
    # player's fixture window): The Odds API sometimes REISSUES a cup
    # fixture under a brand new external_id once its real kickoff slot
    # is confirmed (the old id keeps a generic placeholder time like
    # 15:00, still in `fixtures` but no longer actively priced) - the
    # `on conflict (external_id)` upsert above can't catch that, since
    # by definition it's a value it's never seen before, so it just
    # inserted a second row for the same real match every time. Same two
    # teams + same competition + same season only legitimately happens
    # once in a normal season (no side replays itself in the same cup),
    # so if a fixture already exists for this real matchup under a
    # DIFFERENT external_id, that's the reissue case - adopt the new
    # external_id onto the existing row instead of creating a new one.
    if existing is None:
        cur.execute(
            "select id, kickoff_at from fixtures where competition = %s and season = %s and home_team_id = %s and away_team_id = %s",
            (competition, season, home_team_id, away_team_id),
        )
        reissued = cur.fetchone()
        if reissued is not None:
            existing = reissued
            cur.execute(
                "update fixtures set external_id = %s, kickoff_at = %s where id = %s",
                (external_id, kickoff_at, reissued[0]),
            )
            fixture_id = reissued[0]
            log_event(
                cur,
                "fixture_rescheduled",
                f"{home_name} vs {away_name} reissued under a new external_id, kickoff now {kickoff_at.strftime('%d %b %Y %H:%M')} UTC",
                fixture_id=fixture_id,
                details={"old_kickoff_at": reissued[1].isoformat() if reissued[1] else None, "new_kickoff_at": kickoff_at.isoformat()},
            )
            return fixture_id

    cur.execute(
        """
        insert into fixtures (external_id, competition, season, home_team_id, away_team_id, kickoff_at)
        values (%s, %s, %s, %s, %s, %s)
        on conflict (external_id) do update
            set competition = excluded.competition,
                season = excluded.season,
                home_team_id = excluded.home_team_id,
                away_team_id = excluded.away_team_id,
                kickoff_at = excluded.kickoff_at
        returning id
        """,
        (external_id, competition, season, home_team_id, away_team_id, kickoff_at),
    )
    fixture_id = cur.fetchone()[0]

    if existing is None:
        log_event(
            cur,
            "fixture_added",
            f"{home_name} vs {away_name} added, kickoff {kickoff_at.strftime('%d %b %Y %H:%M')} UTC",
            fixture_id=fixture_id,
            details={"home_team_id": home_team_id, "away_team_id": away_team_id, "kickoff_at": kickoff_at.isoformat()},
        )
    elif existing[1] != kickoff_at:
        log_event(
            cur,
            "fixture_rescheduled",
            f"{home_name} vs {away_name} moved from {existing[1].strftime('%d %b %Y %H:%M')} to {kickoff_at.strftime('%d %b %Y %H:%M')} UTC",
            fixture_id=fixture_id,
            details={"old_kickoff_at": existing[1].isoformat(), "new_kickoff_at": kickoff_at.isoformat()},
        )

    return fixture_id


def insert_odds(cur, fixture_id, bookmaker, home_price, draw_price, away_price):
    cur.execute(
        """
        insert into fixture_odds (fixture_id, bookmaker, home_price, draw_price, away_price)
        values (%s, %s, %s, %s, %s)
        on conflict (fixture_id, bookmaker, fetched_at) do nothing
        """,
        (fixture_id, bookmaker, home_price, draw_price, away_price),
    )


def main():
    load_env()
    api_key = os.environ["ODDS_API_KEY"]
    conn = psycopg2.connect(os.environ["DATABASE_URL"])
    conn.autocommit = False
    cur = conn.cursor()

    try:
        cur.execute("select distinct competition from game_competitions order by competition")
        competitions = [r[0] for r in cur.fetchall()]

        total_fixtures = 0
        total_odds = 0

        for competition in competitions:
            events = fetch_odds(competition, api_key)
            print(f"{competition}: {len(events)} fixtures with odds")

            for event in events:
                kickoff = datetime.fromisoformat(event["commence_time"].replace("Z", "+00:00"))
                home_id = resolve_team_id(cur, event["home_team"])
                away_id = resolve_team_id(cur, event["away_team"])
                fixture_id = upsert_fixture(
                    cur, event["id"], competition, season_for(kickoff), home_id, away_id, kickoff,
                    event["home_team"], event["away_team"],
                )
                total_fixtures += 1

                for bookmaker in event.get("bookmakers", []):
                    market = next((m for m in bookmaker["markets"] if m["key"] == "h2h"), None)
                    if not market:
                        continue
                    prices = {o["name"]: o["price"] for o in market["outcomes"]}
                    home_price = prices.get(event["home_team"])
                    away_price = prices.get(event["away_team"])
                    draw_price = prices.get("Draw")
                    if not (home_price and away_price and draw_price):
                        continue
                    insert_odds(cur, fixture_id, bookmaker["key"], home_price, draw_price, away_price)
                    total_odds += 1

        conn.commit()
        print(f"\nDone: {total_fixtures} fixtures upserted, {total_odds} odds rows inserted.")
    except Exception:
        conn.rollback()
        raise
    finally:
        cur.close()
        conn.close()


if __name__ == "__main__":
    main()
