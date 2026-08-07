"""
set_manual_pl_fixture_strength.py
------------------------------------
Overwrites team_season_strength.home_strength/away_strength (migration
0102) for all 20 Premier League teams with the user's own manually-rated
fixture-difficulty scale (screenshotted 2026-08-07 from their own FDR
tool - a 1-5 rating per team, separately for home and away). This is the
SAME fallback tier compute_fixture_strength_probabilities.py already
reads home_strength/away_strength from (previously only populated for
EFL Fantasy) - real bookmaker match odds (fixture_probabilities) still
take precedence over it in every case, via team_fixture_difficulty's
COALESCE (migration 0017/0010). This only replaces what happens BEFORE
real odds are posted for a fixture, which for Dream Team/FanTeam/Cloud FF
is most of the season, and all of pre-season.

Deliberately does NOT touch top5_prob/relegation_prob/strength (the
single flat rating compute_team_strength.py already wrote from QuickBet's
top-5/relegation markets) - those stay as an unused fallback-of-the-
fallback (compute_fixture_strength_probabilities.py only reads `strength`
when home_strength/away_strength are null), never overwritten here.

Scale: 1-5 rating -> (rating - 3) / 2, giving -1.0 (weakest, e.g. Hull
City) .. +1.0 (strongest, e.g. Arsenal/Man City), matching `strength`'s
own documented "roughly -1..1" range so the existing Bradley-Terry model
in compute_fixture_strength_probabilities.py (STEEPNESS=3.0) needs no
changes.

RUN:
    python3 scripts/set_manual_pl_fixture_strength.py
    python3 scripts/compute_fixture_strength_probabilities.py   # regenerate off the new ratings
    python3 scripts/compute_projections.py dreamteam --gameweek 1
    python3 scripts/compute_projections.py fanteam --gameweek <current>
    python3 scripts/compute_projections.py cloudff --gameweek <current>
"""

import os
from pathlib import Path

import psycopg2

ROOT = Path(__file__).resolve().parent.parent
SEASON = "2026/27"
SOURCE = "user_manual_fdr_2026-08-07"

# name -> (home rating, away rating), both 1 (weakest opponent) .. 5
# (strongest opponent). Transcribed directly from the user's own FDR
# tool screenshot - all 20 current Premier League clubs.
RATINGS = {
    "Arsenal": (5, 5),
    "Manchester City": (5, 5),
    "Liverpool": (4, 5),
    "Manchester United": (4, 4),
    "Chelsea": (4, 4),
    "Aston Villa": (3, 4),
    "Tottenham Hotspur": (3, 4),
    "Crystal Palace": (3, 3),
    "Bournemouth": (3, 3),
    "Sunderland": (3, 3),
    "Brighton": (3, 3),
    "Newcastle United": (3, 3),
    "Brentford": (2, 3),
    "Everton": (2, 3),
    "Leeds United": (2, 3),
    "Nottingham Forest": (2, 3),
    "Fulham": (2, 3),
    "Coventry City": (1, 2),
    "Ipswich Town": (1, 1),
    "Hull City": (1, 1),
}


def load_env():
    for line in (ROOT / ".env").read_text().splitlines():
        line = line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, _, value = line.partition("=")
        os.environ.setdefault(key.strip(), value.strip())


def to_strength(rating: int) -> float:
    return (rating - 3) / 2


def main():
    load_env()
    conn = psycopg2.connect(os.environ["DATABASE_URL"])
    conn.autocommit = False
    cur = conn.cursor()

    try:
        updated = 0
        for team_name, (home_rating, away_rating) in RATINGS.items():
            cur.execute("select id from teams where name = %s", (team_name,))
            row = cur.fetchone()
            if not row:
                raise SystemExit(f"No canonical team found for {team_name!r}")
            team_id = row[0]

            home_strength = round(to_strength(home_rating), 4)
            away_strength = round(to_strength(away_rating), 4)

            cur.execute(
                """
                update team_season_strength
                set home_strength = %s, away_strength = %s, source = %s, computed_at = now()
                where team_id = %s and season = %s
                """,
                (home_strength, away_strength, SOURCE, team_id, SEASON),
            )
            if cur.rowcount == 0:
                raise SystemExit(
                    f"No team_season_strength row for {team_name!r} (season {SEASON!r}) - "
                    "run compute_team_strength.py first to seed the base row."
                )
            updated += 1

        conn.commit()
        print(f"Set home/away fixture-strength ratings for {updated} teams.")

        cur.execute(
            """
            select t.name, s.home_strength, s.away_strength
            from team_season_strength s join teams t on t.id = s.team_id
            where s.season = %s order by (s.home_strength + s.away_strength) desc
            """,
            (SEASON,),
        )
        for row in cur.fetchall():
            print(f"  {row[0]:<26} home={row[1]:+.2f}  away={row[2]:+.2f}")
    except Exception:
        conn.rollback()
        raise
    finally:
        cur.close()
        conn.close()


if __name__ == "__main__":
    main()
