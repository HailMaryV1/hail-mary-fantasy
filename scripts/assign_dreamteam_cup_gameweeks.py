"""
assign_dreamteam_cup_gameweeks.py
------------------------------------
Dream Team's own gameweek calendar (game_fixture_gameweeks, populated by
import_dreamteam.py's sync_gameweek_calendar) only ever covers the 380
real soccer_epl fixtures - it's a straight copy of FanTeam's calendar,
and FanTeam doesn't play cup/European competitions at all, so a Carabao
Cup or Champions League fixture never gets a gameweek number from that
path even though `fixtures` already has real rows for them (confirmed
live 2026-08-07: soccer_england_efl_cup, soccer_uefa_champs_league_
qualification) and dreamteam is already scoped to all 6 non-EPL
competitions it can play via game_competitions (migration 0074's
pattern - see that table for the full list: efl_cup, fa_cup, champs_
league, champs_league_qualification, europa_league, europa_conference_
league). Result: a PL club that plays TWO fixtures in the same real
week (league + cup) only ever shows up as having one, everywhere in the
app that reasons about a gameweek - exactly the gap the user flagged
2026-08-07 (11 non-European PL clubs have a Carabao Cup tie in GW1,
progressing ones again in GW3).

Method: PL gameweeks don't line up with cup rounds' own numbering, so
this buckets by DATE instead - each gameweek's window is [that
gameweek's earliest real EPL kickoff, the next gameweek's earliest
kickoff), open-ended for the last gameweek. A cup fixture's kickoff
falling inside gameweek N's window is "part of GW1's week" the same way
a fan would read a Tuesday-night Carabao Cup tie sandwiched between two
Saturday league rounds - not tied to the cup competition's own round
number, which doesn't correspond to any PL gameweek at all.

Only fixtures involving at least one of the 20 real Premier League clubs
are assigned - a Championship-vs-League One EFL Cup tie with no PL club
in it is irrelevant to Dream Team (whose entire player pool is PL-only).

Idempotent / safe to re-run: ON CONFLICT DO NOTHING against
game_fixture_gameweeks' existing (game_id, fixture_id) unique
constraint, and PL fixtures (already owned by sync_gameweek_calendar)
are never touched - competition is restricted to the 5 explicit
non-'soccer_epl' cup/Europe values already seeded in game_competitions
for dreamteam.

RUN:
    python3 scripts/assign_dreamteam_cup_gameweeks.py
"""

import os
from pathlib import Path

import psycopg2
import psycopg2.extras

ROOT = Path(__file__).resolve().parent.parent

# The 20 real 2026/27 Premier League clubs - same canonical names used
# throughout this repo (teamColors.ts, compute_team_strength.py).
PL_CLUBS = {
    "Arsenal", "Aston Villa", "Bournemouth", "Brentford", "Brighton", "Chelsea",
    "Coventry City", "Crystal Palace", "Everton", "Fulham", "Hull City", "Ipswich Town",
    "Leeds United", "Liverpool", "Manchester City", "Manchester United", "Newcastle United",
    "Nottingham Forest", "Sunderland", "Tottenham Hotspur",
}

CUP_COMPETITIONS = [
    "soccer_england_efl_cup",
    "soccer_fa_cup",
    "soccer_uefa_champs_league",
    "soccer_uefa_champs_league_qualification",
    "soccer_uefa_europa_league",
    "soccer_uefa_europa_conference_league",
]


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


def main():
    load_env()
    conn = psycopg2.connect(os.environ["DATABASE_URL"])
    conn.autocommit = False
    cur = conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor)

    try:
        cur.execute("select id from fantasy_games where slug = 'dreamteam'")
        row = cur.fetchone()
        if not row:
            raise SystemExit("No dreamteam fantasy_games row found.")
        game_id = row["id"]

        cur.execute(
            """
            select gfg.gameweek, min(f.kickoff_at) as start_at
            from game_fixture_gameweeks gfg
            join fixtures f on f.id = gfg.fixture_id
            where gfg.game_id = %s and f.competition = 'soccer_epl'
            group by gfg.gameweek
            order by gfg.gameweek
            """,
            (game_id,),
        )
        gw_starts = cur.fetchall()
        if not gw_starts:
            raise SystemExit("No PL gameweek calendar found - run import_dreamteam.py first.")

        # [start_N, start_{N+1}) windows, last gameweek open-ended.
        windows = []
        for i, gw in enumerate(gw_starts):
            end_at = gw_starts[i + 1]["start_at"] if i + 1 < len(gw_starts) else None
            windows.append((gw["gameweek"], gw["start_at"], end_at))

        cur.execute("select id, name from teams where name = any(%s)", (list(PL_CLUBS),))
        pl_team_ids = {r["id"] for r in cur.fetchall()}
        if len(pl_team_ids) != len(PL_CLUBS):
            raise SystemExit(f"Expected {len(PL_CLUBS)} PL team ids, resolved {len(pl_team_ids)} - check PL_CLUBS spelling.")

        cur.execute(
            "select id, competition, home_team_id, away_team_id, kickoff_at from fixtures where competition = any(%s) order by kickoff_at",
            (CUP_COMPETITIONS,),
        )
        cup_fixtures = [
            f for f in cur.fetchall() if f["home_team_id"] in pl_team_ids or f["away_team_id"] in pl_team_ids
        ]

        assigned, unmatched = 0, 0
        gw_counts = {}
        for f in cup_fixtures:
            gw = None
            for gameweek, start_at, end_at in windows:
                if f["kickoff_at"] >= start_at and (end_at is None or f["kickoff_at"] < end_at):
                    gw = gameweek
                    break
            if gw is None:
                unmatched += 1
                continue
            cur.execute(
                """
                insert into game_fixture_gameweeks (game_id, fixture_id, gameweek)
                values (%s, %s, %s)
                on conflict (game_id, fixture_id) do nothing
                """,
                (game_id, f["id"], gw),
            )
            assigned += 1
            gw_counts[gw] = gw_counts.get(gw, 0) + 1

        conn.commit()
        print(f"Assigned {assigned} cup/Europe fixtures to Dream Team gameweeks ({unmatched} fell outside every window).")
        for gw in sorted(gw_counts):
            print(f"  GW{gw}: {gw_counts[gw]} cup/Europe fixture(s)")

        # Double-gameweek report: PL clubs with 2+ fixtures (any
        # competition) in the same Dream Team gameweek.
        cur.execute(
            """
            select gfg.gameweek, t.name as team_name, count(*) as fixture_count
            from game_fixture_gameweeks gfg
            join fixtures f on f.id = gfg.fixture_id
            join teams t on t.id in (f.home_team_id, f.away_team_id)
            where gfg.game_id = %s and t.name = any(%s)
            group by gfg.gameweek, t.name
            having count(*) > 1
            order by gfg.gameweek, t.name
            """,
            (game_id, list(PL_CLUBS)),
        )
        double_gws = cur.fetchall()
        print(f"\nDouble-fixture gameweeks after this run: {len(double_gws)}")
        for r in double_gws:
            print(f"  GW{r['gameweek']}: {r['team_name']} - {r['fixture_count']} fixtures")
    except Exception:
        conn.rollback()
        raise
    finally:
        cur.close()
        conn.close()


if __name__ == "__main__":
    main()
