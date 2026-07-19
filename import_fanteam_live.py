"""
import_fanteam_live.py
------------------------
Loads live 2026/27 FanTeam data (scraper_fanteam.py output) into
Supabase: real fixtures mapped to real gameweek numbers, and current
player prices/identities.

Fixtures: FanTeam's own fixture list represents the same real-world
matches already in `fixtures` (sourced from The Odds API) - confirmed
by cross-checking gameweek 1 team pairings and kickoff times, which
matched exactly. So this reuses existing fixture rows (matched by team
pair + kickoff time) instead of creating duplicates, and records the
real gameweek number via game_fixture_gameweeks - replacing the
period_start/period_end placeholder with FanTeam's actual calendar.
Any fixture not already present (Odds API hasn't reached that far
ahead yet) gets created fresh from FanTeam's own data.

Players: FanTeam's live API uses a different internal ID scheme than
last season's CSV (confirmed: CSV ids like 1677501 vs live ids like
4700617 - a different numbering system, likely a platform migration).
So this matches live players to existing canonical players by name +
position (same surname-matching heuristic as match_players.py) -
deliberately NOT constrained by team, because a player's team_id in our
`players` table reflects LAST SEASON and may be stale after summer
transfers. A confident name match here also corrects that team_id to
the current one, fixing the exact staleness gap flagged since the
first Hail Mary Score run. Anyone not found (new signings, promoted
sides) gets a new canonical player created. Anyone with an existing
FanTeam game_players row NOT in this live pull gets deactivated
(is_active = false) - relegated clubs (Burnley, West Ham, Wolves this
season), dropped players, etc. Found by testing the squad builder
against real relegation data rather than assumed - it initially left
stale relegated-team players pickable.

RUN:
    python3 import_fanteam_live.py
"""

import json
import os
import re
import sys
from datetime import datetime
from pathlib import Path

import psycopg2
import psycopg2.extras

ROOT = Path(__file__).resolve().parent
sys.path.insert(0, str(ROOT / "scripts"))
from activity_log import log_event  # noqa: E402

SEASON = "2026/27"

# FanTeam's live API spells some team names differently from our
# canonical names (which came from Dream Team/FanTeam's historical
# CSVs and Odds API). Discovered empirically by comparing FanTeam's
# realTeams list against `teams`.
TEAM_ALIASES = {
    "Coventry": "Coventry City",
    "Hull": "Hull City",
    "Ipswich": "Ipswich Town",
    "Leeds": "Leeds United",
    "Newcastle": "Newcastle United",
    "Spurs": "Tottenham Hotspur",
}

POSITION_MAP = {
    "goalkeeper": "GK",
    "defender": "DEF",
    "midfielder": "MID",
    "forward": "FWD",
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


def compact(name: str) -> str:
    return re.sub(r"[^a-z]", "", name.lower())


def surname_key(full_name: str) -> str:
    if ". " in full_name:
        return compact(full_name.split(". ", 1)[1])
    return compact(full_name.split(" ")[-1])


def resolve_team_id(cur, live_name: str) -> int:
    canonical = TEAM_ALIASES.get(live_name, live_name)
    cur.execute("select id from teams where name = %s", (canonical,))
    row = cur.fetchone()
    if not row:
        raise SystemExit(f"No canonical team found for FanTeam team {live_name!r} (mapped to {canonical!r})")
    return row[0]


def import_fixtures(cur, game_id, fixtures_data, team_id_by_real_id):
    written, created, matched = 0, 0, 0
    for m in fixtures_data["realMatches"]:
        home_real, away_real = m["realTeamIds"]
        home_id = team_id_by_real_id[home_real]
        away_id = team_id_by_real_id[away_real]
        kickoff = datetime.fromisoformat(m["startTime"])

        cur.execute(
            "select id from fixtures where home_team_id = %s and away_team_id = %s and kickoff_at = %s",
            (home_id, away_id, kickoff),
        )
        row = cur.fetchone()
        if row:
            fixture_id = row[0]
            matched += 1
        else:
            cur.execute(
                """
                insert into fixtures (external_id, competition, season, home_team_id, away_team_id, kickoff_at)
                values (%s, %s, %s, %s, %s, %s)
                returning id
                """,
                (f"fanteam:{m['id']}", "soccer_epl", SEASON, home_id, away_id, kickoff),
            )
            fixture_id = cur.fetchone()[0]
            created += 1

        cur.execute(
            """
            insert into game_fixture_gameweeks (game_id, fixture_id, gameweek)
            values (%s, %s, %s)
            on conflict (game_id, fixture_id) do update set gameweek = excluded.gameweek
            """,
            (game_id, fixture_id, m["gameweek"]),
        )
        written += 1

    print(f"Fixtures: {written} gameweek mappings written ({matched} matched existing, {created} newly created).")


def import_players(cur, game_id, players_data, team_id_by_real_id):
    # All canonical players, bucketed by position, for name matching.
    cur.execute("select id, full_name, position, team_id from players")
    by_position: dict[str, list[tuple]] = {}
    for pid, full_name, position, team_id in cur.fetchall():
        by_position.setdefault(position, []).append((pid, full_name, team_id))

    # For activity_log summaries ("moved from X to Y") - teams table is
    # tiny, cheap to load whole.
    cur.execute("select id, name from teams")
    team_name_by_id = {tid: name for tid, name in cur.fetchall()}

    matched, created, ambiguous, updated_team, status_written = 0, 0, 0, 0, 0
    seen_external_ids = set()

    for pc in players_data["playerChoices"]:
        live_position = POSITION_MAP[pc["position"]]
        live_team_id = team_id_by_real_id[pc["realTeamId"]]
        real_player = pc["realPlayer"]
        # Mononym players (Gabriel, Savinho, Rodri, ...) have lastName = null;
        # the API gives customName as the clean display name for exactly this
        # case rather than "Firstname None".
        is_mononym = not real_player["lastName"]
        if is_mononym:
            live_full_name = real_player["customName"] or real_player["firstName"]
        else:
            live_full_name = f"{real_player['firstName']} {real_player['lastName']}".strip()
        live_compact = compact(live_full_name)

        # Normal case: live name ends with the candidate's surname (handles
        # "E. Haaland" vs "Erling Haaland" - different first-name formats,
        # same surname). A bare mononym like "Gabriel" can't end with a
        # surname it doesn't contain, so for that case also accept the
        # candidate's full name simply starting with the mononym - catches
        # "Gabriel" matching stored "Gabriel Magalhaes".
        candidates = [
            (pid, name, team_id)
            for pid, name, team_id in by_position.get(live_position, [])
            if live_compact.endswith(surname_key(name))
            or (is_mononym and compact(name).startswith(live_compact))
        ]

        # An exact compact-name match beats any looser prefix/suffix
        # candidate outright (resolves e.g. "Rodri" matching both itself
        # and "Rodrigo Bentancur" via the mononym-prefix rule above).
        if len(candidates) > 1:
            exact = [c for c in candidates if compact(c[1]) == live_compact]
            if len(exact) == 1:
                candidates = exact

        if len(candidates) > 1:
            live_initial = live_full_name[0].lower()
            narrowed = [c for c in candidates if c[1][0].lower() == live_initial]
            if len(narrowed) == 1:
                candidates = narrowed

        # Last resort for genuine name collisions (e.g. two players called
        # "Gabriel"): prefer whichever candidate's stored team already
        # matches the live team. Team can be stale after a transfer, but
        # for disambiguating between distinct same-named players it's a
        # reasonable signal - most name matches aren't also transfer cases.
        if len(candidates) > 1:
            team_matches = [c for c in candidates if c[2] == live_team_id]
            if len(team_matches) == 1:
                candidates = team_matches

        if len(candidates) > 1:
            ambiguous += 1
            print(f"  [ambiguous] {live_full_name} ({live_position}) -> {[c[1] for c in candidates]}")
            continue

        if candidates:
            player_id, canonical_name, canonical_team_id = candidates[0]
            matched += 1
            if canonical_team_id != live_team_id:
                cur.execute("update players set team_id = %s where id = %s", (live_team_id, player_id))
                updated_team += 1
                old_team_name = team_name_by_id.get(canonical_team_id, "an unknown club")
                new_team_name = team_name_by_id.get(live_team_id, "an unknown club")
                log_event(
                    cur,
                    "team_changed",
                    f"{canonical_name} moved from {old_team_name} to {new_team_name}",
                    game_id=game_id,
                    details={"player_id": player_id, "old_team_id": canonical_team_id, "new_team_id": live_team_id},
                )
        else:
            cur.execute(
                "insert into players (full_name, team_id, position) values (%s, %s, %s) returning id",
                (live_full_name, live_team_id, live_position),
            )
            player_id = cur.fetchone()[0]
            created += 1

        cur.execute("select id from game_players where game_id = %s and player_id = %s", (game_id, player_id))
        row = cur.fetchone()
        external_id = str(pc["realPlayerId"])
        seen_external_ids.add(external_id)
        if row:
            game_player_id = row[0]
            cur.execute(
                "update game_players set external_id = %s, position_code = %s, price = %s, is_active = true, updated_at = now() where id = %s",
                (external_id, pc["position"], pc["price"], game_player_id),
            )
        else:
            live_team_name = team_name_by_id.get(live_team_id, "an unknown club")
            log_event(
                cur,
                "player_added",
                f"{live_full_name} added to FanTeam ({live_position}, {live_team_name})",
                game_id=game_id,
                details={"player_id": player_id, "position": live_position, "team_id": live_team_id},
            )
            cur.execute(
                """
                insert into game_players (game_id, player_id, external_id, position_code, price, is_active)
                values (%s, %s, %s, %s, %s, true)
                on conflict (game_id, external_id) do update
                    set player_id = excluded.player_id, position_code = excluded.position_code, price = excluded.price,
                        is_active = true, updated_at = now()
                returning id
                """,
                (game_id, player_id, external_id, pc["position"], pc["price"]),
            )
            game_player_id = cur.fetchone()[0]

        # Pre-match status (lineup likelihood + availability) plus form/
        # minutes/points (FanTeam's own recent-performance fields, also
        # captured verbatim - see migration 0029) for this player's
        # currently-editable gameweek - upsert-overwrite per
        # (game_player_id, gameweek) since only the latest known state
        # matters (see migration 0027's docstring - the exact lineup/status
        # raw-string taxonomy isn't confirmed yet, so this just stores
        # whatever FanTeam sends).
        cur.execute(
            """
            insert into fanteam_player_status
                (game_player_id, gameweek, lineup, status, scraped_at, form, minutes, total_points, last_points)
            values (%s, %s, %s, %s, now(), %s, %s, %s, %s)
            on conflict (game_player_id, gameweek) do update
                set lineup = excluded.lineup, status = excluded.status, scraped_at = excluded.scraped_at,
                    form = excluded.form, minutes = excluded.minutes,
                    total_points = excluded.total_points, last_points = excluded.last_points
            """,
            (
                game_player_id, pc["gameweek"], pc.get("lineup"), pc.get("status"),
                pc.get("form"), pc.get("minutes"), pc.get("totalPoints"), pc.get("lastPoints"),
            ),
        )
        status_written += 1

    print(f"Players: {matched} matched ({updated_team} team corrected), {created} newly created, {ambiguous} ambiguous (skipped).")
    print(f"Player status: {status_written} lineup/status rows captured.")

    # Anyone with an existing FanTeam game_players row whose external_id
    # wasn't in this live pull is no longer in the game (relegated,
    # dropped, etc.) - deactivate rather than delete, so their historical
    # stats/projections stay intact.
    cur.execute("select external_id from game_players where game_id = %s and is_active = true", (game_id,))
    currently_active = {row[0] for row in cur.fetchall()}
    stale_ids = currently_active - seen_external_ids
    if stale_ids:
        cur.execute(
            "update game_players set is_active = false, updated_at = now() where game_id = %s and external_id = any(%s)",
            (game_id, list(stale_ids)),
        )
        print(f"Deactivated {len(stale_ids)} players no longer in FanTeam's live list (relegated/dropped).")


def main():
    # --skip-fixtures: only import players (prices/positions/lineup/status)
    # - used by the automated pipeline (scripts/refresh_all.py), which only
    # ever runs scraper_fanteam.py --players-only and so has no
    # fanteam_fixtures_raw.json to read. Fixture/gameweek mapping stays a
    # manual, occasional path (needs a real login - see scraper_fanteam.py).
    skip_fixtures = "--skip-fixtures" in sys.argv[1:]

    load_env()
    conn = psycopg2.connect(os.environ["DATABASE_URL"])
    conn.autocommit = False
    cur = conn.cursor()

    try:
        cur.execute("select id from fantasy_games where slug = 'fanteam'")
        game_id = cur.fetchone()[0]

        players_data = json.loads((ROOT / "fanteam_players_raw.json").read_text(encoding="utf-8"))
        fixtures_data = None if skip_fixtures else json.loads((ROOT / "fanteam_fixtures_raw.json").read_text(encoding="utf-8"))

        team_id_by_real_id = {}
        if fixtures_data is not None:
            for t in fixtures_data["realTeams"]:
                team_id_by_real_id[t["id"]] = resolve_team_id(cur, t["name"])
        for t in players_data["realTeams"]:
            team_id_by_real_id.setdefault(t["id"], resolve_team_id(cur, t["name"]))

        if fixtures_data is not None:
            import_fixtures(cur, game_id, fixtures_data, team_id_by_real_id)
        import_players(cur, game_id, players_data, team_id_by_real_id)

        conn.commit()
        print("\nDone.")
    except Exception:
        conn.rollback()
        raise
    finally:
        cur.close()
        conn.close()


if __name__ == "__main__":
    main()
