"""
import_eflfantasy_season_outlook.py
------------------------------------
Loads the bookmakers' promotion/relegation favourite markets for the
Championship/League One/League Two into team_season_outlook (migration
0113). Manually supplied by the user (2026-08-09) - there's no API for
this, it's the top-5 favourites in each market, by hand.

This exists because there is no real season-long form/results data for any
EFL club before a ball is kicked - the bookmakers' own promotion/
relegation odds are the only meaningful proxy for "how good is this club
going to be this season" pre-season. See eflSeasonOutlook.ts for how this
gets consumed (and switched off once the season actually starts).

Fractional odds ("8/11") are converted to implied probability via
den / (den + num) - the standard no-vig-adjustment conversion (this is a
directional signal, not a precise probability estimate, so skipping vig
removal is fine here).

RUN:
    python3 scripts/import_eflfantasy_season_outlook.py
"""
import os
from fractions import Fraction
from pathlib import Path

import psycopg2

ROOT = Path(__file__).resolve().parent.parent

SOURCE = "bookmaker_odds_manual"
SEASON = "2026/27"

# A few names differ from how fantasy.efl.com (and this DB's teams table)
# spells them - resolved before lookup rather than guessed at query time.
NAME_ALIASES = {
    "West Ham": "West Ham United",
    "Wolves": "Wolverhampton Wanderers",
}

# Each entry: (competition, outlook, [(rank, club_name, "num/den"), ...])
DATA = [
    ("efl_championship", "relegation", [
        (1, "Lincoln City", "8/11"),
        (2, "Bolton Wanderers", "11/8"),
        (3, "Cardiff City", "11/8"),
        (4, "Charlton Athletic", "6/4"),
        (5, "Preston North End", "4/1"),
    ]),
    ("efl_league_one", "relegation", [
        (1, "Bromley", "11/10"),
        (1, "AFC Wimbledon", "11/10"),
        (3, "Burton Albion", "6/4"),
        (4, "Cambridge United", "7/4"),
        (5, "Notts County", "3/1"),
        # Joint 5th in the real market alongside Notts County - explicitly
        # flagged by the user, not an omission.
        (5, "Leyton Orient", "3/1"),
    ]),
    ("efl_league_two", "relegation", [
        (1, "Newport County", "2/1"),
        (2, "Accrington Stanley", "7/2"),
        (3, "Crawley Town", "4/1"),
        (4, "Tranmere Rovers", "6/1"),
        (5, "Cheltenham Town", "7/1"),
    ]),
    ("efl_championship", "promotion", [
        (1, "West Ham", "4/7"),
        (2, "Wolves", "17/10"),
        (3, "Middlesbrough", "11/4"),
        (4, "Burnley", "3333/1000"),  # quoted as "3333/1000 (~10/3)" - kept exact
        (5, "Birmingham City", "4/1"),
    ]),
    ("efl_league_one", "promotion", [
        (1, "Leicester City", "4/5"),
        (2, "Sheffield Wednesday", "9/4"),
        (3, "Luton Town", "11/4"),
        (4, "Stockport County", "9/2"),
        (5, "Huddersfield Town", "9/2"),
    ]),
    ("efl_league_two", "promotion", [
        (1, "Salford City", "6/4"),
        (2, "Bristol Rovers", "2/1"),
        (3, "Barnet", "9/4"),
        (4, "Port Vale", "9/4"),
        (5, "Chesterfield", "5/2"),
    ]),
]


def load_env():
    env_path = ROOT / ".env"
    if not env_path.exists():
        return
    for line in env_path.read_text().splitlines():
        line = line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, _, value = line.partition("=")
        os.environ.setdefault(key.strip(), value.strip())


def implied_probability(odds_fraction: str) -> float:
    frac = Fraction(odds_fraction)
    decimal_odds = 1 + frac
    return float(1 / decimal_odds)


def main():
    load_env()
    conn = psycopg2.connect(os.environ["DATABASE_URL"])
    cur = conn.cursor()

    cur.execute("select id, name from teams")
    team_id_by_name = {name: tid for tid, name in cur.fetchall()}

    written, skipped = 0, []

    for competition, outlook, rows in DATA:
        for rank, club_name, odds_fraction in rows:
            resolved_name = NAME_ALIASES.get(club_name, club_name)
            team_id = team_id_by_name.get(resolved_name)
            if not team_id:
                skipped.append((competition, outlook, club_name))
                continue
            prob = implied_probability(odds_fraction)
            cur.execute(
                """
                insert into team_season_outlook
                    (team_id, competition, outlook, rank, odds_fraction, implied_probability, season, source)
                values (%s, %s, %s, %s, %s, %s, %s, %s)
                on conflict (team_id, competition, outlook, season) do update
                    set rank = excluded.rank, odds_fraction = excluded.odds_fraction,
                        implied_probability = excluded.implied_probability
                """,
                (team_id, competition, outlook, rank, odds_fraction, prob, SEASON, SOURCE),
            )
            written += 1

    conn.commit()
    print(f"Wrote {written} rows for season {SEASON}.")
    if skipped:
        print("\nSkipped (no matching team found):")
        for competition, outlook, club_name in skipped:
            print(f"  [{competition} {outlook}] {club_name!r}")

    cur.close()
    conn.close()


if __name__ == "__main__":
    main()
