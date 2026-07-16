"""
import_fixture_extras.py
--------------------------
Pulls team-goal-total and player prop markets per fixture (the richer
signals that give a real clean-sheet probability and player-specific
scoring probability, instead of approximating from win/draw odds).

Unlike import_fixtures_odds.py (one bulk call per competition), this
hits the per-event endpoint once per fixture, because that's where the
Odds API exposes these markets. Confirmed empirically: bookmakers don't
post them until close to matchday, so runs made weeks out will
correctly insert nothing - that's expected, not a bug. Intended to run
in the days before each gameweek, not on the same daily schedule as the
basic fixture/h2h pull.

player_name_raw is stored as-is; resolving it to a players.id requires
a name-matching approach we can't build yet (no real Odds API player
names exist to test against until this actually returns data).

RUN:
    python3 scripts/import_fixture_extras.py [--limit N]
"""

import json
import os
import sys
import urllib.error
import urllib.request
from pathlib import Path

import psycopg2

ROOT = Path(__file__).resolve().parent.parent
ODDS_BASE = "https://api.the-odds-api.com/v4"

PLAYER_PROP_MARKETS = ["player_goal_scorer_anytime", "player_shots_on_target", "player_assists"]
TEAM_TOTAL_MARKETS = ["team_totals", "alternate_team_totals"]
ALL_EXTRA_MARKETS = ",".join(TEAM_TOTAL_MARKETS + PLAYER_PROP_MARKETS + ["btts"])


def load_env():
    for line in (ROOT / ".env").read_text().splitlines():
        line = line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, _, value = line.partition("=")
        os.environ.setdefault(key.strip(), value.strip())


def fetch_event_odds(competition, external_id, api_key):
    url = (
        f"{ODDS_BASE}/sports/{competition}/events/{external_id}/odds"
        f"?apiKey={api_key}&regions=uk&markets={ALL_EXTRA_MARKETS}"
    )
    req = urllib.request.Request(url, headers={"User-Agent": "Mozilla/5.0"})
    try:
        with urllib.request.urlopen(req, timeout=20) as resp:
            return json.loads(resp.read())
    except urllib.error.HTTPError as e:
        print(f"  [warn] {external_id}: HTTP {e.code} - {e.read()[:200]}")
        return None


def resolve_team_id(cur, name):
    cur.execute(
        "select team_id from team_aliases where source = 'oddsapi' and external_name = %s",
        (name,),
    )
    row = cur.fetchone()
    return row[0] if row else None


def insert_team_total(cur, fixture_id, team_id, bookmaker, line, over_price, under_price):
    cur.execute(
        """
        insert into fixture_team_totals (fixture_id, team_id, bookmaker, line, over_price, under_price)
        values (%s, %s, %s, %s, %s, %s)
        """,
        (fixture_id, team_id, bookmaker, line, over_price, under_price),
    )


def insert_player_prop(cur, fixture_id, player_name_raw, market, bookmaker, price, line):
    cur.execute(
        """
        insert into fixture_player_props (fixture_id, player_name_raw, market, bookmaker, price, line)
        values (%s, %s, %s, %s, %s, %s)
        """,
        (fixture_id, player_name_raw, market, bookmaker, price, line),
    )


def process_event(cur, fixture_id, home_team_name, away_team_name, event):
    team_totals_added = 0
    props_added = 0

    for bookmaker in event.get("bookmakers", []):
        for market in bookmaker.get("markets", []):
            key = market["key"]

            if key in TEAM_TOTAL_MARKETS:
                # Outcomes look like {"name": "Over", "description": "Arsenal", "price": 1.8, "point": 1.5}
                by_team_and_line = {}
                for outcome in market["outcomes"]:
                    team_name = outcome.get("description")
                    team_id = resolve_team_id(cur, team_name) if team_name else None
                    if not team_id:
                        continue
                    line = outcome.get("point")
                    slot = by_team_and_line.setdefault((team_id, line), {})
                    slot[outcome["name"]] = outcome["price"]

                for (team_id, line), prices in by_team_and_line.items():
                    if "Over" in prices and "Under" in prices:
                        insert_team_total(cur, fixture_id, team_id, bookmaker["key"], line, prices["Over"], prices["Under"])
                        team_totals_added += 1

            elif key in PLAYER_PROP_MARKETS:
                for outcome in market["outcomes"]:
                    player_name = outcome.get("description") or outcome.get("name")
                    insert_player_prop(
                        cur, fixture_id, player_name, key, bookmaker["key"],
                        outcome["price"], outcome.get("point"),
                    )
                    props_added += 1

    return team_totals_added, props_added


def main():
    limit = None
    if "--limit" in sys.argv:
        limit = int(sys.argv[sys.argv.index("--limit") + 1])

    load_env()
    api_key = os.environ["ODDS_API_KEY"]
    conn = psycopg2.connect(os.environ["DATABASE_URL"])
    conn.autocommit = False
    cur = conn.cursor()

    try:
        cur.execute(
            """
            select f.id, f.external_id, f.competition, ht.name, at.name
            from fixtures f
            join teams ht on ht.id = f.home_team_id
            join teams at on at.id = f.away_team_id
            order by f.kickoff_at
            """
        )
        fixtures = cur.fetchall()
        if limit:
            fixtures = fixtures[:limit]

        total_team_totals, total_props, checked = 0, 0, 0

        for fixture_id, external_id, competition, home_name, away_name in fixtures:
            event = fetch_event_odds(competition, external_id, api_key)
            checked += 1
            if event is None:
                continue
            tt, pp = process_event(cur, fixture_id, home_name, away_name, event)
            total_team_totals += tt
            total_props += pp
            if tt or pp:
                print(f"{home_name} vs {away_name}: {tt} team-total rows, {pp} player-prop rows")

        conn.commit()
        print(f"\nChecked {checked} fixtures. Inserted {total_team_totals} team-total rows, {total_props} player-prop rows.")
        if total_team_totals == 0 and total_props == 0:
            print("(Expected this far from kickoff - bookmakers haven't posted these markets yet.)")
    except Exception:
        conn.rollback()
        raise
    finally:
        cur.close()
        conn.close()


if __name__ == "__main__":
    main()
