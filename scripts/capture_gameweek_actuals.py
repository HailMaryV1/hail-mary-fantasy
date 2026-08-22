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

Also captures EFL Fantasy's real actuals (capture_eflfantasy_actuals below) -
same target table, different source again: fantasy.efl.com's players.json
(see scraper_eflfantasy.py) carries a `lastThree` field per player -
[{"roundId", "points"}, ...] for up to the last 3 completed rounds. No
per-round minutes field exists in this feed (same gap import_eflfantasy.py's
minutes_played already documents) - a round appearing in lastThree is
treated as a full 90-minute appearance, the same full-match proxy used
throughout this project for this exact gap.

UNCONFIRMED, same class of caveat as the captures above: whether a round
missing from lastThree always means "didn't play" (vs. "played, scored
exactly 0, and rounds off the rolling window differently than assumed")
can't be fully confirmed off a single real completed gameweek (2026-08-19,
GW1 the only one done so far). Real bug this whole capture step fixes:
nothing was capturing EFL Fantasy's real per-gameweek results at all before
now - Performance Lab/Ask Mary grading and Recent Form
(compute_projections.py's build_recent_form_rates, already wired in for
this game) had zero real data to work from, on top of the season's
historical-baseline player-identity mismatch (see NEUTRAL_POSITION_PRIOR's
docstring) - this is the fix for that second, larger gap. Sanity-check
against the next real completed gameweek once it lands.

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

Also captures Dream Team's real actuals (capture_dreamteam_actuals below) -
same target table, its own real api/players/stats endpoint (see
scraper_dreamteam_stats.py/seed_dreamteam_historical_stats.py), read via a
SELF-CONTAINED live fetch here rather than that scraper's own raw JSON
file: this script runs in refresh_wrapup.yml, a SEPARATE GitHub Actions
job/checkout from refresh_dreamteam.yml (confirmed by both workflows'
own cron schedules - dreamteam at :36, wrapup at :12 nearly an hour
later, each `actions/checkout`-ing fresh), so a file written by an
earlier job's run_step() simply doesn't exist on this job's runner. This
was ALSO the real bug behind capture_eflfantasy_actuals below until
2026-08-22 (it used to read eflfantasy_players_raw.json off disk, which
was exactly as absent in real CI wrap-up runs - confirmed via
player_gameweek_results.captured_at, whose only two real EFL Fantasy
capture timestamps both fell outside the wrapup cron's own 07:12/19:12
UTC fire times, meaning every real capture so far came from a local dev
run, never the schedule itself) - now fixed the same way, see
fetch_eflfantasy_players() below. This function does not repeat that
mistake either: matchdayPoints only ever exposes
ONE gameweek at a time (no startGW/endGW range like Cloud FF's own
endpoint), taken to mean "the most recently completed one" and matched
against this project's own completed_gameweeks determination (same 3h-
post-kickoff proxy as Cloud FF) - a best-effort, once-per-run capture,
same class of limitation as the FanTeam N-1 capture above (acceptable
as long as this runs at least once between any two real gameweeks
completing, which it does - twice daily).

No real per-gameweek minutes field exists for Dream Team either (same
gap as FanTeam/EFL Fantasy, see scraper_dreamteam_stats.py's docstring)
- unlike FanTeam's misleading literal 0 or EFL Fantasy's labeled-
approximation 90, actual_minutes is left NULL here (the column is
nullable - see migration 0034) since there's no honest number, real or
proxied, worth writing.

RUN:
    python3 scripts/capture_gameweek_actuals.py
"""

import gzip
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


EFLFANTASY_PLAYERS_URL = "https://fantasy.efl.com/json/fantasy/players.json"


def fetch_eflfantasy_players():
    """Live fetch of fantasy.efl.com's real players.json - NOT a read of
    eflfantasy_players_raw.json off disk (that was this function's real
    bug until 2026-08-22: this script runs in refresh_wrapup.yml, a
    separate GitHub Actions job/checkout from refresh_eflfantasy.yml,
    which is the only job that ever writes that file - confirmed via
    player_gameweek_results.captured_at, which only ever landed at times
    matching a local/manual run, never the wrapup cron's actual 07:12/
    19:12 UTC fire times, across every real row captured so far. Same
    gzip-regardless-of-Accept-Encoding handling as scraper_eflfantasy.
    py's own fetch_json - duplicated here rather than imported, matching
    capture_dreamteam_actuals' own self-contained live-fetch pattern
    just above, for the same separate-CI-job reason."""
    req = urllib.request.Request(EFLFANTASY_PLAYERS_URL, headers={"User-Agent": "Mozilla/5.0"})
    with urllib.request.urlopen(req, timeout=30) as resp:
        raw = resp.read()
    if raw[:2] == b"\x1f\x8b":
        raw = gzip.decompress(raw)
    return json.loads(raw)


def capture_eflfantasy_actuals(conn):
    cur = conn.cursor()
    try:
        cur.execute("select id from fantasy_games where slug = 'eflfantasy'")
        row = cur.fetchone()
        if not row:
            print("No eflfantasy fantasy_games row - skipping EFL Fantasy actuals capture.")
            return
        game_id = row[0]

        players_data = fetch_eflfantasy_players()

        # external_id-keyed, not player_id - same reasoning as
        # gk_team_and_price in compute_projections.py: game_player_id is
        # what player_gameweek_predictions/results are actually keyed on.
        cur.execute(
            "select id, external_id from game_players where game_id = %s and position_code != 'CLUB'",
            (game_id,),
        )
        game_player_id_by_external_id = {external_id: gp_id for gp_id, external_id in cur.fetchall()}

        written = 0
        for p in players_data:
            game_player_id = game_player_id_by_external_id.get(str(p["id"]))
            if game_player_id is None:
                continue
            for round_entry in p.get("lastThree") or []:
                gameweek = round_entry.get("roundId")
                points = round_entry.get("points")
                if gameweek is None or points is None:
                    continue
                cur.execute(
                    """
                    insert into player_gameweek_results (game_id, game_player_id, gameweek, actual_points, actual_minutes, captured_at)
                    values (%s, %s, %s, %s, %s, now())
                    on conflict (game_id, game_player_id, gameweek) do update
                        set actual_points = excluded.actual_points, actual_minutes = excluded.actual_minutes,
                            captured_at = excluded.captured_at
                    """,
                    (game_id, game_player_id, gameweek, points, 90),
                )
                written += 1

        conn.commit()
        print(f"Captured {written} real EFL Fantasy gameweek-actual rows (lastThree window).")
    except Exception:
        conn.rollback()
        raise
    finally:
        cur.close()


DREAMTEAM_STATS_URL = "https://engagecraft-fantasy-backend-prod.azurewebsites.net/api/players/stats"


def fetch_dreamteam_player_stats():
    """All real pages of Dream Team's live api/players/stats endpoint -
    same pagination shape as scraper_dreamteam_stats.py (limit=100,
    empty items list = done), duplicated here rather than imported since
    this needs to run standalone in a separate CI job with no shared
    filesystem state - see this module's own docstring."""
    all_items = []
    page = 1
    while True:
        body = fetch_json(f"{DREAMTEAM_STATS_URL}?limit=100&page={page}")
        items = body["data"]["items"]
        if not items:
            break
        all_items.extend(items)
        page += 1
    return all_items


def capture_dreamteam_actuals(conn):
    cur = conn.cursor()
    try:
        cur.execute("select id from fantasy_games where slug = 'dreamteam'")
        row = cur.fetchone()
        if not row:
            print("No dreamteam fantasy_games row - skipping Dream Team actuals capture.")
            return
        game_id = row[0]

        # Same real-data-grounded "match finished" proxy as Cloud FF
        # above - every one of the gameweek's real fixtures kicked off
        # at least 3 hours ago.
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
            print("No completed Dream Team gameweeks yet - skipping Dream Team actuals capture.")
            return
        most_recent_completed_gw = max(completed_gameweeks)

        cur.execute("select id, external_id from game_players where game_id = %s", (game_id,))
        game_player_id_by_external_id = {external_id: gp_id for gp_id, external_id in cur.fetchall()}

        stats = fetch_dreamteam_player_stats()
        written = 0
        for s in stats:
            game_player_id = game_player_id_by_external_id.get(str(s["playerId"]))
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
                (game_id, game_player_id, most_recent_completed_gw, s["matchdayPoints"], None),
            )
            written += 1

        conn.commit()
        print(f"Captured {written} real Dream Team gameweek-actual rows for gameweek {most_recent_completed_gw}.")
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
    capture_eflfantasy_actuals(conn)
    capture_dreamteam_actuals(conn)
    conn.close()


if __name__ == "__main__":
    main()
