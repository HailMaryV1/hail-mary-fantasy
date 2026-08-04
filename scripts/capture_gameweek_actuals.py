"""
capture_gameweek_actuals.py
----------------------------
Mary Performance Lab, Part 2 - captures the "what actually happened" data
that nothing in this pipeline retains today.

fanteam_player_status.total_points/last_points cannot serve this role:
import_fanteam_live.py upserts it per (game_player_id, gameweek) for
whichever gameweek is currently EDITABLE (upcoming), so once that
gameweek closes and the editable round advances, the previous gameweek's
values are gone - there is no history there (see migration 0029, and
0034_player_gameweek_results.sql's docstring).

This script instead reads the CURRENT fanteam_player_status row for each
player - captured moments ago by import_fanteam_live.py - and treats its
`last_points`/`minutes` fields as the ACTUAL result of gameweek N-1,
where N is that row's own (editable) gameweek. Writes into
player_gameweek_results, keyed by (game_id, game_player_id, N-1) so a
later, more-settled scrape (e.g. after a post-match points correction)
safely overwrites an earlier one for the same gameweek instead of
duplicating it.

UNCONFIRMED, same as compute_projections.py's lineup/status mapping:
whether `lastPoints` really means "points scored in the previous
gameweek" can't be verified until a real gameweek actually completes -
there is no season-started data yet (2026-07-20). Sanity-check the
first real values once GW1 finishes.

Skips gameweek 1 (N-1 = 0 is meaningless - nothing has been played yet).

Also captures Cloud FF's real actuals (capture_cloudff_actuals below) -
same target table, different source: Cloud FF has no per-gameweek
"currently editable round" status table to read like FanTeam's, but its
own getPlayerStats endpoint (see scraper_cloudff.py) genuinely supports
narrow ?startGW=N&endGW=N windows, confirmed live, returning that single
gameweek's real TotalPoints/TotalMinutesPlayed per player - Cloud FF's
own backend has already applied their real scoring rules to it, so this
is used directly rather than recomputed (unlike
seed_cloudff_historical_stats.py's season-aggregate shrinkage prior,
which recomputes under this project's own rules for a different reason -
see that script's docstring).

Grading precision note (accepted, see plan): this is per-GAMEWEEK, not
per-fixture - a genuine double-gameweek (two match-days, same gameweek,
same team) can't be disambiguated with this data source. No finer real
source was found live (checked cloud-ff.co.uk's discovered API calls and
Match Centre) - revisit once the season starts and a real double-
gameweek occurs.

UNCONFIRMED, same class of caveat as the FanTeam capture above: which
season getPlayerStats' own gameweek numbers refer to before the new
season kicks off is untested - the live 2026-08-04 test that confirmed
?startGW=N&endGW=N works returned real non-zero data for gameweeks that
haven't happened yet in THIS project's 2026/27 game_fixture_gameweeks
calendar, strongly suggesting the endpoint's numbering currently still
refers to the completed 2025/26 season (matches the season-long totals
already seeded as this project's historical prior). completed_gameweeks
below is derived from real 2026/27 fixtures.kickoff_at, so it can't
return anything until the new season genuinely starts - by which point
Cloud FF's own gameweek numbering should have rolled over too, but that
hasn't been (and can't yet be) verified against a real completed 2026/27
gameweek. Sanity-check the first real GW1 values once the season starts.

RUN:
    python3 scripts/capture_gameweek_actuals.py
"""

import json
import os
import urllib.request
from pathlib import Path

import psycopg2

ROOT = Path(__file__).resolve().parent.parent

CLOUDFF_PLAYER_STATS_URL = "https://europe-west2-cloudfantasy-449312.cloudfunctions.net/getPlayerStats"


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


def capture_cloudff_actuals(conn):
    cur = conn.cursor()
    try:
        cur.execute("select id from fantasy_games where slug = 'cloudff'")
        row = cur.fetchone()
        if not row:
            print("No cloudff fantasy_games row - skipping Cloud FF actuals capture.")
            return
        game_id = row[0]

        # A gameweek counts as "complete" once every one of its real
        # fixtures kicked off at least 3 hours ago - a simple, real-data-
        # grounded proxy for "the match has finished" without needing a
        # separate full-time-status source.
        cur.execute(
            """
            select distinct gfg.gameweek
            from game_fixture_gameweeks gfg
            join fixtures f on f.id = gfg.fixture_id
            where gfg.game_id = %s
            group by gfg.gameweek
            having max(f.kickoff_at) < now() - interval '3 hours'
            order by gfg.gameweek
            """,
            (game_id,),
        )
        completed_gameweeks = [r[0] for r in cur.fetchall()]
        if not completed_gameweeks:
            print("No completed Cloud FF gameweeks yet - skipping Cloud FF actuals capture.")
            return

        cur.execute("select id, external_id from game_players where game_id = %s", (game_id,))
        game_player_id_by_external_id = {external_id: gp_id for gp_id, external_id in cur.fetchall()}

        written = 0
        for gw in completed_gameweeks:
            stats = fetch_json(f"{CLOUDFF_PLAYER_STATS_URL}?startGW={gw}&endGW={gw}")
            for s in stats:
                game_player_id = game_player_id_by_external_id.get(str(s["id"]))
                if game_player_id is None:
                    continue
                cur.execute(
                    """
                    insert into player_gameweek_results (game_id, game_player_id, gameweek, actual_points, actual_minutes, captured_at)
                    values (%s, %s, %s, %s, %s, now())
                    on conflict (game_id, game_player_id, gameweek) do update
                        set actual_points = excluded.actual_points, actual_minutes = excluded.actual_minutes,
                            captured_at = excluded.captured_at
                    """,
                    (game_id, game_player_id, gw, s["TotalPoints"], s["TotalMinutesPlayed"]),
                )
                written += 1

        conn.commit()
        print(f"Captured {written} real Cloud FF gameweek-actual rows across gameweeks {completed_gameweeks}.")
    except Exception:
        conn.rollback()
        raise
    finally:
        cur.close()


def main():
    load_env()
    conn = psycopg2.connect(os.environ["DATABASE_URL"])
    conn.autocommit = False
    cur = conn.cursor()

    try:
        cur.execute(
            """
            select gp.game_id, s.game_player_id, s.gameweek, s.last_points, s.minutes
            from fanteam_player_status s
            join game_players gp on gp.id = s.game_player_id
            where s.gameweek >= 2
            """
        )
        rows = cur.fetchall()

        written = 0
        for game_id, game_player_id, gameweek, last_points, minutes in rows:
            actual_gameweek = gameweek - 1
            cur.execute(
                """
                insert into player_gameweek_results (game_id, game_player_id, gameweek, actual_points, actual_minutes, captured_at)
                values (%s, %s, %s, %s, %s, now())
                on conflict (game_id, game_player_id, gameweek) do update
                    set actual_points = excluded.actual_points, actual_minutes = excluded.actual_minutes,
                        captured_at = excluded.captured_at
                """,
                (game_id, game_player_id, actual_gameweek, last_points, minutes),
            )
            written += 1

        conn.commit()
        print(f"Captured {written} gameweek-actual rows from {len(rows)} current player-status records.")
    except Exception:
        conn.rollback()
        raise
    finally:
        cur.close()

    capture_cloudff_actuals(conn)
    conn.close()


if __name__ == "__main__":
    main()
