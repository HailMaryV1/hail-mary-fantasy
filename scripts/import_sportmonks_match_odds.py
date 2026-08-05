"""
import_sportmonks_match_odds.py
---------------------------------
Real bookmaker match-winner odds for EFL Fantasy's 3 divisions
(Championship/League One/League Two), confirmed live 2026-08-06: all
three are entitled under this project's SportMonks subscription (league
ids 9/12/14 - the player-props script's own ENTITLED_LEAGUE_IDS is
stale, missing 12/14) and, for the real GW1 fixtures (2026-08-14 to
2026-08-17 - NOT the same date as FanTeam's Premier League GW1 on
2026-08-21; EFL's own divisions start a week earlier, confirmed from
this project's own game_fixture_gameweeks data), every fixture checked
is already fully priced (15/15 sampled, 550-620 real odds rows each).

This directly replaces the crude proxy compute_club_scores() has been
running the fixture-adjustment half of its calculation on (last
season's own-division average fantasy points, z-scored - see
seed_team_strength() in import_eflfantasy.py). Real bookmaker odds
already price in exactly what that proxy structurally can't: a promoted
club being a big underdog in its new, harder division (and a relegated
club being a big favourite in its new, easier one). Confirmed live:
Notts County (promoted to League One) was projecting 9.8 pts against
Leicester City purely off inflated League Two form - the real market
(fixture 19728337) has them at ~29% to win that match.

Writes into the exact same `fixture_odds` table (fixture_id, bookmaker,
home_price, draw_price, away_price) that import_fixtures_odds.py already
writes for every Odds-API-covered competition - deliberately reuses that
shape so the existing, fully generic compute_fixture_probabilities.py
(queries ALL fixtures, no competition filter) picks these up
automatically with zero changes needed there. team_fixture_difficulty's
real-odds-first COALESCE (migration 0017) does the rest - no view
changes either.

Team names match exactly between SportMonks and this project's `teams`
table for every real GW1 EFL fixture (confirmed live: 0 mismatches
across 50 distinct team names) - no alias table needed, unlike
import_fixtures_odds.py's ODDS_NAME_OVERRIDES.

Fixture matching: SportMonks fixture -> our fixtures row, by (home team
name, away team name, same calendar date) - not exact kickoff_at, since
lower-league fixtures occasionally get TV-rescheduled by a few hours
between the two feeds without the day itself changing.

Safe to re-run: fixture_odds is append-only (same convention as
import_fixtures_odds.py) - each run adds a fresh snapshot, preserving
odds movement over time rather than overwriting.

RUN:
    python3 scripts/import_sportmonks_match_odds.py
"""
import json
import os
import urllib.error
import urllib.request
from datetime import datetime, timedelta, timezone
from pathlib import Path

import psycopg2

ROOT = Path(__file__).resolve().parent.parent
SPORTMONKS_BASE = "https://api.sportmonks.com/v3/football"

# Confirmed live 2026-08-06 via /v3/football/leagues - Championship,
# League One, League Two. Matches EFL Fantasy's 3 synthetic competition
# strings (see migration 0088's docstring) in the same order.
LEAGUE_ID_BY_COMPETITION = {
    "efl_championship": 9,
    "efl_league_one": 12,
    "efl_league_two": 14,
}

# How far ahead to pull fixtures/odds for - lower-league odds aren't
# posted far in advance (confirmed live: zero rows 15+ days out for
# Championship/League One, fully priced by ~8 days out), so there's no
# point requesting further ahead than this and burning API quota on
# fixtures nothing has priced yet.
LOOKAHEAD_DAYS = 21

# Fulltime Result (1X2 match-winner market) - confirmed live via a real
# fixture's odds response (market_id=1, label in Home/Draw/Away).
FULLTIME_RESULT_MARKET_ID = 1

# Known SportMonks spellings that differ from this project's canonical
# `teams.name` - same pattern as import_fixtures_odds.py's
# ODDS_NAME_OVERRIDES. Discovered empirically: SportMonks' own
# /fixtures/between/ endpoint isn't even internally consistent about
# this - the same real fixture ID returned "MK Dons" on one call and
# "Milton Keynes Dons" on another (confirmed live, 2026-08-06) - so this
# is applied defensively to every participant name, not just ones a
# single test happened to catch.
SPORTMONKS_NAME_OVERRIDES = {
    "Milton Keynes Dons": "MK Dons",
}


def canonical_name(name: str) -> str:
    return SPORTMONKS_NAME_OVERRIDES.get(name, name)


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


def fetch_json(url):
    req = urllib.request.Request(url, headers={"User-Agent": "Mozilla/5.0"})
    with urllib.request.urlopen(req, timeout=30) as resp:
        return json.loads(resp.read())


def fetch_fixtures(api_key, league_ids, start_date, end_date):
    ids = ",".join(str(i) for i in league_ids)
    url = (
        f"{SPORTMONKS_BASE}/fixtures/between/{start_date}/{end_date}"
        f"?api_token={api_key}&filters=fixtureLeagues:{ids}&include=participants&per_page=100"
    )
    fixtures = []
    while url:
        data = fetch_json(url)
        fixtures.extend(data.get("data", []))
        pagination = data.get("pagination") or {}
        url = pagination.get("next_page") if pagination.get("has_more") else None
        if url and "api_token=" not in url:
            url = f"{url}&api_token={api_key}"
    return fixtures


def fetch_odds(api_key, sportmonks_fixture_id):
    url = f"{SPORTMONKS_BASE}/odds/pre-match/fixtures/{sportmonks_fixture_id}?api_token={api_key}"
    try:
        data = fetch_json(url)
    except urllib.error.HTTPError as e:
        print(f"  [warn] fixture {sportmonks_fixture_id}: HTTP {e.code}")
        return []
    return data.get("data", [])


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
    api_key = os.environ["SPORTMONKS_API_KEY"]
    conn = psycopg2.connect(os.environ["DATABASE_URL"])
    conn.autocommit = False
    cur = conn.cursor()

    try:
        now = datetime.now(timezone.utc)

        # Our own upcoming eflfantasy fixtures, keyed by (home name, away
        # name, calendar date) - matched below against SportMonks'
        # equivalent, not by external_id (ours are
        # "eflfantasy:{roundGameId}", SportMonks has its own unrelated
        # numbering with no crosswalk).
        cur.execute(
            """
            select f.id, ht.name as home_name, at.name as away_name, f.kickoff_at
            from fixtures f
            join teams ht on ht.id = f.home_team_id
            join teams at on at.id = f.away_team_id
            where f.competition in %s and f.kickoff_at >= %s and f.kickoff_at < %s
            """,
            (tuple(LEAGUE_ID_BY_COMPETITION.keys()), now, now + timedelta(days=LOOKAHEAD_DAYS)),
        )
        our_fixtures = cur.fetchall()
        by_key = {(home_name, away_name, kickoff_at.date()): fid for fid, home_name, away_name, kickoff_at in our_fixtures}
        print(f"{len(our_fixtures)} upcoming EFL Fantasy fixtures to match against SportMonks.")

        start_date = now.date().isoformat()
        end_date = (now + timedelta(days=LOOKAHEAD_DAYS)).date().isoformat()
        sm_fixtures = fetch_fixtures(api_key, LEAGUE_ID_BY_COMPETITION.values(), start_date, end_date)
        print(f"{len(sm_fixtures)} SportMonks fixtures found in that window across Championship/L1/L2.")

        matched, priced, odds_written = 0, 0, 0
        for f in sm_fixtures:
            participants = f.get("participants", [])
            home = next((p for p in participants if (p.get("meta") or {}).get("location") == "home"), None)
            away = next((p for p in participants if (p.get("meta") or {}).get("location") == "away"), None)
            starting_at = f.get("starting_at")
            if not home or not away or not starting_at:
                continue

            match_date = datetime.fromisoformat(starting_at.replace(" ", "T")).date()
            our_fixture_id = by_key.get((canonical_name(home.get("name")), canonical_name(away.get("name")), match_date))
            if our_fixture_id is None:
                continue
            matched += 1

            odds_rows = fetch_odds(api_key, f["id"])
            fulltime = [r for r in odds_rows if r.get("market_id") == FULLTIME_RESULT_MARKET_ID]
            if not fulltime:
                continue
            priced += 1

            by_bookmaker: dict[int, dict[str, float]] = {}
            for r in fulltime:
                bookmaker_id = r.get("bookmaker_id")
                label = r.get("label")
                value = r.get("value")
                if bookmaker_id is None or label not in ("Home", "Draw", "Away") or value is None:
                    continue
                by_bookmaker.setdefault(bookmaker_id, {})[label] = float(value)

            for bookmaker_id, prices in by_bookmaker.items():
                if "Home" in prices and "Draw" in prices and "Away" in prices:
                    insert_odds(cur, our_fixture_id, f"sportmonks_{bookmaker_id}", prices["Home"], prices["Draw"], prices["Away"])
                    odds_written += 1

        conn.commit()
        print(f"\nDone: {matched} fixtures matched, {priced} already priced, {odds_written} bookmaker odds rows written.")
    except Exception:
        conn.rollback()
        raise
    finally:
        cur.close()
        conn.close()


if __name__ == "__main__":
    main()
