"""
compute_team_strength.py
--------------------------
Fallback team strength rating for fixtures with no real match odds yet
(the vast majority of the season - bookmakers only price individual
matches close to kickoff). Uses season-long "to finish top 5" and
"relegation" outright odds instead, which exist for the whole season
right now.

Odds are QuickBet's 2026/27 EPL top-5-finish and relegation markets
(manually provided by the user as screenshots on 2026-07-17 - not an
API, so this needs re-running by hand with fresh odds occasionally,
not on a schedule). Hardcoded here rather than parsed from an image,
since that's the actual source.

Method: convert fractional odds -> implied probability -> normalize
(top 5 market: exactly 5 winners, so probabilities are scaled to sum
to 5; relegation: exactly 3, scaled to sum to 3) -> overround removed
in the process, same principle as compute_fixture_probabilities.py.
strength = top5_prob - relegation_prob (roughly -1..1: strongly
positive for the best teams, strongly negative for relegation
favourites, near zero for mid-table).

RUN:
    python3 scripts/compute_team_strength.py
"""

import os
from pathlib import Path

import psycopg2

ROOT = Path(__file__).resolve().parent.parent
SEASON = "2026/27"
SOURCE = "quickbet_manual_2026-07-17"

# name -> fractional odds string, as shown by QuickBet.
TOP5_ODDS = {
    "Arsenal": "1/12", "Manchester City": "1/4", "Liverpool": "3/10", "Manchester United": "1/3",
    "Chelsea": "5/6", "Aston Villa": "2/1", "Tottenham Hotspur": "2/1", "Newcastle United": "5/1",
    "Brighton": "5/1", "Bournemouth": "8/1", "Brentford": "9/1", "Everton": "8/1",
    "Nottingham Forest": "12/1", "Crystal Palace": "14/1", "Leeds United": "14/1", "Fulham": "16/1",
    "Sunderland": "20/1", "Coventry City": "100/1", "Ipswich Town": "100/1", "Hull City": "150/1",
}

RELEGATION_ODDS = {
    "Hull City": "1/4", "Ipswich Town": "4/6", "Coventry City": "8/13", "Sunderland": "11/4",
    "Fulham": "11/2", "Leeds United": "11/2", "Crystal Palace": "11/2", "Nottingham Forest": "7/1",
    "Brentford": "8/1", "Everton": "9/1", "Bournemouth": "9/1", "Manchester City": "12/1",
    "Brighton": "25/1", "Newcastle United": "20/1", "Tottenham Hotspur": "40/1", "Aston Villa": "66/1",
    "Chelsea": "66/1", "Liverpool": "750/1", "Manchester United": "500/1", "Arsenal": "1000/1",
}


def load_env():
    for line in (ROOT / ".env").read_text().splitlines():
        line = line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, _, value = line.partition("=")
        os.environ.setdefault(key.strip(), value.strip())


def fractional_to_decimal(frac: str) -> float:
    num, den = frac.split("/")
    return 1 + int(num) / int(den)


def normalize(odds_by_team: dict, winners: int) -> dict:
    raw = {team: 1 / fractional_to_decimal(odds) for team, odds in odds_by_team.items()}
    total = sum(raw.values())
    scale = winners / total
    return {team: prob * scale for team, prob in raw.items()}


def main():
    load_env()
    conn = psycopg2.connect(os.environ["DATABASE_URL"])
    conn.autocommit = False
    cur = conn.cursor()

    try:
        top5 = normalize(TOP5_ODDS, winners=5)
        relegation = normalize(RELEGATION_ODDS, winners=3)

        if set(top5) != set(relegation):
            raise SystemExit(f"Team name mismatch between the two odds sets: {set(top5) ^ set(relegation)}")

        written = 0
        for team_name in top5:
            cur.execute("select id from teams where name = %s", (team_name,))
            row = cur.fetchone()
            if not row:
                raise SystemExit(f"No canonical team found for {team_name!r}")
            team_id = row[0]

            top5_prob = top5[team_name]
            relegation_prob = relegation[team_name]
            strength = top5_prob - relegation_prob

            cur.execute(
                """
                insert into team_season_strength (team_id, season, top5_prob, relegation_prob, strength, source)
                values (%s, %s, %s, %s, %s, %s)
                on conflict (team_id, season) do update
                    set top5_prob = excluded.top5_prob, relegation_prob = excluded.relegation_prob,
                        strength = excluded.strength, source = excluded.source, computed_at = now()
                """,
                (team_id, SEASON, round(top5_prob, 4), round(relegation_prob, 4), round(strength, 4), SOURCE),
            )
            written += 1

        conn.commit()
        print(f"Wrote strength ratings for {written} teams.")

        cur.execute(
            """
            select t.name, s.top5_prob, s.relegation_prob, s.strength
            from team_season_strength s join teams t on t.id = s.team_id
            where s.season = %s order by s.strength desc
            """,
            (SEASON,),
        )
        for row in cur.fetchall():
            print(f"  {row[0]:<26} top5={row[1]:.3f}  releg={row[2]:.3f}  strength={row[3]:+.3f}")
    except Exception:
        conn.rollback()
        raise
    finally:
        cur.close()
        conn.close()


if __name__ == "__main__":
    main()
