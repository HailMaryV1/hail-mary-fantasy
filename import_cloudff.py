"""
import_cloudff.py
-------------------
Loads live Cloud Fantasy Football data (scraper_cloudff.py output) into
Supabase, reusing the same shared players/teams/fixtures tables every
other game already uses (confirmed: teams.short_name is only populated
for NFL clubs - EPL clubs are matched by full name instead, same as
import_fanteam_live.py's resolve_team_id).

Team resolution: Cloud FF's OWN fixtures.json already pairs every real
short code with its own display name (e.g. "MUN"->"Man Utd",
"TOT"->"Spurs") - CLOUDFF_TEAM_ALIASES below maps each of those 20 real
pairs (extracted live, not guessed) to this project's canonical
teams.name spelling (confirmed live via ILIKE lookups - e.g. "Man Utd"
-> "Manchester United", "Spurs" -> "Tottenham Hotspur", "Nott'm Forest"
-> "Nottingham Forest").

Player matching: getPlayerList gives only a last_name (often with a
disambiguating single-letter initial suffix when Cloud FF has two
same-surname players - confirmed live: "Fernandes B", "Wilson H" vs
"Wilson C") plus a real, authoritative team_id and position - unlike
FanTeam's mononym-guessing problem, Cloud FF's team is never stale/wrong
here since it comes straight from the live pull. Candidates are existing
`players` rows whose full_name ends with the (de-suffixed) surname AND
whose team_id matches; the stripped initial (when present) narrows any
remaining tie exactly the way import_fanteam_live.py's first-initial
check does. No match -> logged and skipped, never guessed (same
philosophy as sync_provider_squads.py's match_player).

RUN:
    python3 import_cloudff.py
"""
import json
import os
import sys
import urllib.request
from datetime import datetime
from pathlib import Path

import psycopg2
import psycopg2.extras

ROOT = Path(__file__).resolve().parent
sys.path.insert(0, str(ROOT / "scripts"))
from activity_log import log_event  # noqa: E402
from name_matching import compact, surname_key  # noqa: E402

SEASON = "2026/27"

POSITION_MAP = {1: "GK", 2: "DEF", 3: "MID", 4: "FWD"}

# Same endpoint scraper_cloudff.py already documents as confirmed live -
# startGW=1&endGW=1000 for season-cumulative totals, which is what its
# own real "Ownership" field represents (confirmed live 2026-08-10, e.g.
# Haaland at 92.8%) - a live snapshot, not something scoped to a specific
# gameweek, so the wide range is just "give me everything," not a
# season-total-vs-live distinction that matters here.
CLOUDFF_PLAYER_STATS_URL = "https://europe-west2-cloudfantasy-449312.cloudfunctions.net/getPlayerStats?startGW=1&endGW=1000"

# Cloud FF short code -> its own real display name -> canonical teams.name.
# Extracted live from cloudfixtures/fixtures.json (20/20 real EPL clubs,
# no mismatches against getPlayerList's own short_name set).
CLOUDFF_TEAM_ALIASES = {
    "ARS": "Arsenal",
    "AVL": "Aston Villa",
    "BHA": "Brighton",
    "BOU": "Bournemouth",
    "BRE": "Brentford",
    "CHE": "Chelsea",
    "COV": "Coventry City",
    "CRY": "Crystal Palace",
    "EVE": "Everton",
    "FUL": "Fulham",
    "HUL": "Hull City",
    "IPS": "Ipswich Town",
    "LEE": "Leeds United",
    "LIV": "Liverpool",
    "MCI": "Manchester City",
    "MUN": "Manchester United",
    "NEW": "Newcastle United",
    "NFO": "Nottingham Forest",
    "SUN": "Sunderland",
    "TOT": "Tottenham Hotspur",
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


def strip_disambiguator(last_name: str):
    """("Fernandes", "B") from "Fernandes B" - Cloud FF suffixes a bare
    single capital initial when two players share a surname (confirmed
    live). Returns (surname, None) when there's no such suffix."""
    parts = last_name.rsplit(" ", 1)
    if len(parts) == 2 and len(parts[1]) == 1 and parts[1].isupper():
        return parts[0], parts[1]
    return last_name, None


def resolve_team_id(cur, short_code: str) -> int:
    canonical = CLOUDFF_TEAM_ALIASES.get(short_code)
    if canonical is None:
        raise SystemExit(f"No CLOUDFF_TEAM_ALIASES entry for short code {short_code!r} - a new club, or the mapping needs extending.")
    cur.execute("select id from teams where name = %s", (canonical,))
    row = cur.fetchone()
    if not row:
        raise SystemExit(f"No canonical team found for Cloud FF club {short_code!r} (mapped to {canonical!r})")
    return row[0]


def import_fixtures(cur, game_id, fixtures_data, team_id_by_short):
    written, created, matched = 0, 0, 0
    for f in fixtures_data:
        home_id = team_id_by_short[f["team_h_short"]]
        away_id = team_id_by_short[f["team_a_short"]]
        kickoff = datetime.fromisoformat(f["kickoff_time"].replace("Z", "+00:00"))

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
                (f"cloudff:{f['id']}", "soccer_epl", SEASON, home_id, away_id, kickoff),
            )
            fixture_id = cur.fetchone()[0]
            created += 1

        cur.execute(
            """
            insert into game_fixture_gameweeks (game_id, fixture_id, gameweek)
            values (%s, %s, %s)
            on conflict (game_id, fixture_id) do update set gameweek = excluded.gameweek
            """,
            (game_id, fixture_id, f["event"]),
        )
        written += 1

    print(f"Fixtures: {written} gameweek mappings written ({matched} matched existing, {created} newly created).")


def import_players(cur, game_id, players_data, team_id_by_short):
    cur.execute("select id, full_name, position, team_id from players")
    by_team_position: dict[tuple, list[tuple]] = {}
    for pid, full_name, position, team_id in cur.fetchall():
        by_team_position.setdefault((team_id, position), []).append((pid, full_name))

    matched, created, ambiguous, status_written = 0, 0, 0, 0
    seen_external_ids = set()

    for p in players_data:
        position = POSITION_MAP[p["position"]]
        team_id = team_id_by_short[p["short_name"]]
        surname, initial = strip_disambiguator(p["last_name"])
        surname_compact = compact(surname)

        # surname_key alone assumes "everything after the first word" is
        # the surname, which breaks for a first+middle+surname pattern
        # (confirmed live: "Jan Paul van Hecke" - surname_key gives
        # "paulvanhecke", not "vanhecke") - the endswith fallback catches
        # exactly that case, and is safe from false positives here since
        # it's already scoped to the same real club+position bucket.
        candidates = [
            (pid, name) for pid, name in by_team_position.get((team_id, position), [])
            if surname_key(name) == surname_compact or compact(name).endswith(surname_compact)
        ]

        if len(candidates) > 1 and initial:
            narrowed = [c for c in candidates if c[1].split(" ")[0][:1].upper() == initial]
            if narrowed:
                candidates = narrowed

        if len(candidates) > 1:
            exact = [c for c in candidates if surname_key(c[1]) == surname_compact]
            if len(exact) == 1:
                candidates = exact

        if len(candidates) != 1:
            ambiguous += 1
            print(f"  [unmatched] {p['last_name']} ({position}, team_id={team_id}) -> {[c[1] for c in candidates]}")
            continue

        player_id, canonical_name = candidates[0]
        matched += 1

        cur.execute("select id from game_players where game_id = %s and player_id = %s", (game_id, player_id))
        row = cur.fetchone()
        external_id = str(p["id"])
        seen_external_ids.add(external_id)
        if row:
            game_player_id = row[0]
            cur.execute(
                "update game_players set external_id = %s, position_code = %s, price = %s, is_active = true, updated_at = now() where id = %s",
                (external_id, position, p["price"], game_player_id),
            )
        else:
            log_event(
                cur, "player_added", f"{canonical_name} added to Cloud FF ({position})",
                game_id=game_id, details={"player_id": player_id, "position": position, "team_id": team_id},
            )
            cur.execute(
                """
                insert into game_players (game_id, player_id, external_id, position_code, price, is_active)
                values (%s, %s, %s, %s, %s, true)
                on conflict (game_id, external_id) do update
                    set player_id = excluded.player_id, position_code = excluded.position_code, price = excluded.price,
                        is_active = true, updated_at = now()
                """,
                (game_id, player_id, external_id, position, p["price"]),
            )
        status_written += 1

    print(f"Players: {matched} matched, {ambiguous} unmatched (skipped). {status_written} game_players rows written.")

    cur.execute("select external_id from game_players where game_id = %s and is_active = true", (game_id,))
    currently_active = {row[0] for row in cur.fetchall()}
    stale_ids = currently_active - seen_external_ids
    if stale_ids:
        cur.execute(
            "update game_players set is_active = false, updated_at = now() where game_id = %s and external_id = any(%s)",
            (game_id, list(stale_ids)),
        )
        print(f"Deactivated {len(stale_ids)} players no longer in Cloud FF's live list.")


def import_ownership(cur, game_id):
    """Live ownership % (2026-08-10 user request) - keyed by the same
    external_id getPlayerList already gave every game_players row, so this
    only ever updates existing rows, never inserts."""
    req = urllib.request.Request(CLOUDFF_PLAYER_STATS_URL, headers={"User-Agent": "Mozilla/5.0"})
    with urllib.request.urlopen(req, timeout=30) as resp:
        stats_data = json.loads(resp.read())

    written = 0
    for s in stats_data:
        ownership = s.get("Ownership")
        if ownership is None:
            continue
        cur.execute(
            "update game_players set ownership_pct = %s where game_id = %s and external_id = %s",
            (ownership, game_id, str(s["id"])),
        )
        written += cur.rowcount

    print(f"Ownership: {written} game_players rows updated with live %.")


def main():
    load_env()
    conn = psycopg2.connect(os.environ["DATABASE_URL"])
    conn.autocommit = False
    cur = conn.cursor()

    try:
        cur.execute("select id from fantasy_games where slug = 'cloudff'")
        row = cur.fetchone()
        if not row:
            raise SystemExit("No fantasy_games row for slug='cloudff' - run migration 0072 first.")
        game_id = row[0]

        players_data = json.loads((ROOT / "cloudff_players_raw.json").read_text(encoding="utf-8"))
        fixtures_data = json.loads((ROOT / "cloudff_fixtures_raw.json").read_text(encoding="utf-8"))

        team_id_by_short = {short: resolve_team_id(cur, short) for short in CLOUDFF_TEAM_ALIASES}

        import_fixtures(cur, game_id, fixtures_data, team_id_by_short)
        import_players(cur, game_id, players_data, team_id_by_short)
        import_ownership(cur, game_id)

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
