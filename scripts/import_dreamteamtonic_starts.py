"""
import_dreamteamtonic_starts.py
-----------------------------------
Real per-gameweek "did this player start" data (2026-08-27 user request:
"use players minutes played to see who we expect to start... this could
replace the solio static crap we used for projecting rotation"). Pulls
a public, unauthenticated JSON API behind
https://dreamteamtonic.co.uk/tools/sdt-gw-points - confirmed live via
the browser's own network calls, no auth needed - covering exactly the
3 Premier League games this engine runs:

    dreamteam -> sdt    (no explicit start/sub flag - see below)
    fanteam   -> tff    (real starts/subIns/subOuts fields)
    cloudff   -> cloud  (real StartingXI/Sub fields)

sdt's own single-gameweek response has no starts-equivalent field
(confirmed live: its player rows only carry gamesPlayed/minutesPlayed,
never starts/StartingXI) - minutesPlayed >= 60 is used as the started
heuristic for that source only, never for fanteam/cloudff where a real
flag exists.

Writes into player_gameweek_predictions.actual_started (migration
0152) - the SAME table Recent Form already reads real per-gameweek
results from (fetch_recent_gameweek_observations, compute_projections.py),
so the new "Recent Starts" reader needs no new joins, just one more
column.

Team names: fanteam/cloudff's own squadName already matches this
project's canonical teams.name almost exactly (confirmed live - full
club names), sdt uses short forms ("Man City", "Spurs", ...) - both
resolved through team_aliases (source keys below) the same read-check-
then-insert pattern import_fixtures_odds.py's resolve_team_id already
uses, seeded here with the one-off overrides confirmed live per source.
Never auto-creates a new team row - every real name here is one of the
20 current Premier League clubs, which already exist.

Player matching: name+position, reusing the same surname_variants()
heuristic import_fanteam_live.py already uses (position-bucketed, then
narrowed by exact-match/initial/team - see that file's own matching
block for the full reasoning) - never creates a new canonical player,
only matches into ones that already exist. Logged and skipped when
ambiguous or unmatched, never guessed.

RUN:
    python3 scripts/import_dreamteamtonic_starts.py <game_slug> --gameweek <N>
    python3 scripts/import_dreamteamtonic_starts.py <game_slug> --from-gw 1 --to-gw 5   # backfill
"""

import argparse
import json
import os
import sys
import urllib.error
import urllib.request
from pathlib import Path

import psycopg2

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "scripts"))
from name_matching import compact, first_letter_matches, surname_key, surname_variants  # noqa: E402

API_BASE = "https://dtt-data-api-259295136071.europe-west2.run.app"
SEASON = "202627"  # dreamteamtonic's own compact season code for 2026/27
MIN_SURNAME_KEY_LEN = 2
STARTED_MINUTES_THRESHOLD = 60  # sdt-only fallback, see module docstring

# game_slug -> dreamteamtonic source key + how to read that source's shape.
SOURCES = {
    "dreamteam": {
        "key": "sdt",
        "alias_source": "dreamteamtonic_sdt",
        "team_overrides": {
            "Coventry": "Coventry City", "Forest": "Nottingham Forest", "Hull": "Hull City",
            "Ipswich": "Ipswich Town", "Leeds": "Leeds United", "Man City": "Manchester City",
            "Man Utd": "Manchester United", "Newcastle": "Newcastle United", "Palace": "Crystal Palace",
            "Spurs": "Tottenham Hotspur", "Villa": "Aston Villa",
        },
        "started": lambda p: int(p.get("minutesPlayed") or 0) >= STARTED_MINUTES_THRESHOLD,
    },
    "fanteam": {
        "key": "tff",
        "alias_source": "dreamteamtonic_tff",
        "team_overrides": {"Brighton & Hove Albion": "Brighton"},
        "started": lambda p: int(p.get("starts") or 0) >= 1,
    },
    "cloudff": {
        "key": "cloud",
        "alias_source": "dreamteamtonic_cloud",
        "team_overrides": {"Brighton & Hove Albion": "Brighton"},
        "started": lambda p: str(p.get("StartingXI") or "0") == "1",
    },
}

POSITION_MAP = {"GK": "GK", "DEF": "DEF", "MID": "MID", "FWD": "FWD", "STR": "FWD"}


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


def fetch_gameweek(source_key, gameweek):
    url = f"{API_BASE}/{source_key}/overall-stats-by-gw-extra?season={SEASON}&fromGW={gameweek}&toGW={gameweek}"
    req = urllib.request.Request(url, headers={"User-Agent": "Mozilla/5.0"})
    try:
        with urllib.request.urlopen(req, timeout=20) as resp:
            return json.loads(resp.read())
    except urllib.error.URLError as e:
        print(f"  [warn] GW{gameweek}: fetch failed ({e})")
        return None


def resolve_team_id(cur, alias_source, overrides, raw_name):
    cur.execute("select team_id from team_aliases where source = %s and external_name = %s", (alias_source, raw_name))
    row = cur.fetchone()
    if row:
        return row[0]

    canonical_name = overrides.get(raw_name, raw_name)
    cur.execute("select id from teams where name = %s", (canonical_name,))
    row = cur.fetchone()
    if not row:
        return None
    team_id = row[0]
    cur.execute(
        "insert into team_aliases (team_id, source, external_name) values (%s, %s, %s) on conflict do nothing",
        (team_id, alias_source, raw_name),
    )
    return team_id


def build_player_index(cur):
    cur.execute("select id, full_name, position, team_id from players")
    by_position = {}
    all_players = []
    by_team_position = {}
    for pid, full_name, position, team_id in cur.fetchall():
        by_position.setdefault(position, []).append((pid, full_name, team_id))
        all_players.append((pid, full_name, team_id))
        by_team_position.setdefault((team_id, position), []).append((pid, full_name))
    return by_position, all_players, by_team_position


def strip_disambiguator(last_name):
    """("Fernandes", "B") from "Fernandes B" - Cloud FF's own convention
    for two players sharing a surname (see import_cloudff.py, same
    helper). Returns (last_name, None) when there's no such suffix."""
    parts = last_name.rsplit(" ", 1)
    if len(parts) == 2 and len(parts[1]) == 1 and parts[1].isupper():
        return parts[0], parts[1]
    return last_name, None


def match_player_cloud(by_team_position, live_last_name, live_position, live_team_id):
    """Cloud FF sends a BARE surname (+ optional disambiguator initial),
    never a first name - confirmed live 2026-08-27 that reusing the
    fanteam-style "first word is the first name" matcher against this
    shape matched 0/599 players (surname_variants("Palmer C") reads "C"
    as the whole surname). Mirrors import_cloudff.py's own import_players
    matching exactly - strict (team_id, position) bucket since there's
    no first name left to disambiguate with once two players share both
    a team and a surname."""
    if live_team_id is None:
        return None
    surname, initial = strip_disambiguator(live_last_name)
    surname_compact = compact(surname)

    candidates = [
        (pid, name) for pid, name in by_team_position.get((live_team_id, live_position), [])
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

    if len(candidates) == 1:
        return candidates[0][0]
    return None


def match_player(by_position, all_players, live_full_name, live_position, live_team_id):
    """Same surname_variants()-based heuristic import_fanteam_live.py's
    import_players uses - position-bucketed first (an optimisation, not
    an identity rule), narrowed by exact match / first-initial / team
    only when genuinely ambiguous. Returns a player_id or None - never
    guesses when more than one candidate survives every narrowing step."""
    is_mononym = " " not in live_full_name
    live_compact = compact(live_full_name)
    live_variants = {v for v in surname_variants(live_full_name) if len(v) >= MIN_SURNAME_KEY_LEN}

    def surname_matches(candidate_name):
        candidate_variants = {v for v in surname_variants(candidate_name) if len(v) >= MIN_SURNAME_KEY_LEN}
        if live_variants & candidate_variants:
            return True
        if is_mononym and compact(candidate_name).startswith(live_compact):
            return True
        return False

    candidates = [(pid, name, tid) for pid, name, tid in by_position.get(live_position, []) if surname_matches(name)]
    if not candidates:
        candidates = [(pid, name, tid) for pid, name, tid in all_players if surname_matches(name)]

    if len(candidates) > 1:
        exact = [c for c in candidates if compact(c[1]) == live_compact]
        if len(exact) == 1:
            candidates = exact

    if len(candidates) > 1:
        narrowed = [c for c in candidates if first_letter_matches(c[1], live_full_name)]
        if len(narrowed) == 1:
            candidates = narrowed

    if len(candidates) == 1 and not is_mononym and compact(candidates[0][1]) != live_compact:
        candidate_first_name = candidates[0][1].split(" ", 1)[0].lower()
        live_first_name = live_full_name.split(" ", 1)[0].lower()
        is_nickname_of_candidate = live_first_name and live_first_name in candidate_first_name
        if not first_letter_matches(candidates[0][1], live_full_name) and not is_nickname_of_candidate:
            candidates = []

    if len(candidates) > 1 and live_team_id is not None:
        team_matches = [c for c in candidates if c[2] == live_team_id]
        if len(team_matches) == 1:
            candidates = team_matches

    if len(candidates) == 1:
        return candidates[0][0]
    return None


def import_gameweek(cur, game_id, game_slug, source, gameweek, by_position, all_players, by_team_position):
    data = fetch_gameweek(source["key"], gameweek)
    if not data or not data.get("players"):
        return 0, 0, 0

    matched, unmatched, written = 0, 0, 0
    team_id_cache = {}
    for p in data["players"]:
        raw_team = p.get("squadName")
        if raw_team not in team_id_cache:
            team_id_cache[raw_team] = resolve_team_id(cur, source["alias_source"], source["team_overrides"], raw_team)
        team_id = team_id_cache[raw_team]

        # Cloud FF's own payload carries BOTH a numeric `position` (a raw
        # position-slot id, e.g. 2 - not a code) AND the real letter code
        # under `positionLabel` - `position or positionLabel` picked the
        # truthy number every time and silently matched zero players
        # (confirmed live: 0/599 matched before this fix). positionLabel
        # first, `position` only as a fallback for sources that don't
        # have it at all (sdt/fanteam use `position` as the real code).
        live_position = POSITION_MAP.get(p.get("positionLabel") or p.get("position"))
        display_name = p.get("displayName")
        if not display_name or not live_position:
            continue

        if game_slug == "cloudff":
            player_id = match_player_cloud(by_team_position, display_name, live_position, team_id)
        else:
            player_id = match_player(by_position, all_players, display_name, live_position, team_id)
        if player_id is None:
            unmatched += 1
            continue
        matched += 1

        cur.execute(
            "select gp.id from game_players gp where gp.game_id = %s and gp.player_id = %s",
            (game_id, player_id),
        )
        row = cur.fetchone()
        if not row:
            continue
        game_player_id = row[0]

        cur.execute(
            "update player_gameweek_predictions set actual_started = %s "
            "where game_player_id = %s and gameweek = %s",
            (source["started"](p), game_player_id, gameweek),
        )
        if cur.rowcount > 0:
            written += 1

    print(f"  GW{gameweek}: {matched} matched, {unmatched} unmatched, {written} rows updated")
    return matched, unmatched, written


def already_played_gameweeks(cur, game_id):
    """Every gameweek at least one of this game's real fixtures has
    already kicked off for - real calendar time, not whether OUR OWN
    actual_minutes capture happens to have succeeded for that gameweek
    (confirmed live: Dream Team's own player_gameweek_predictions never
    gets actual_minutes populated at all, a pre-existing gap unrelated
    to this script - using that as the "already played" signal silently
    skipped every Dream Team gameweek in --auto mode). A gameweek still
    partway through kicks off this source's own real, honest partial
    data - never fabricated - and re-running later fills in the rest;
    safe to re-run always applies."""
    cur.execute(
        """
        select distinct gfg.gameweek
        from game_fixture_gameweeks gfg
        join fixtures f on f.id = gfg.fixture_id
        where gfg.game_id = %s and f.kickoff_at < now()
        order by gfg.gameweek
        """,
        (game_id,),
    )
    return [row[0] for row in cur.fetchall()]


def run_for_game(cur, conn, game_slug, gameweeks):
    cur.execute("select id from fantasy_games where slug = %s", (game_slug,))
    row = cur.fetchone()
    if not row:
        raise SystemExit(f"Unknown game slug: {game_slug}")
    game_id = row[0]
    source = SOURCES[game_slug]

    by_position, all_players, by_team_position = build_player_index(cur)

    total_matched, total_unmatched, total_written = 0, 0, 0
    for gw in gameweeks:
        m, u, w = import_gameweek(cur, game_id, game_slug, source, gw, by_position, all_players, by_team_position)
        total_matched += m
        total_unmatched += u
        total_written += w
        conn.commit()

    print(f"{game_slug}: {total_matched} matched, {total_unmatched} unmatched, {total_written} rows updated across {len(gameweeks)} gameweek(s).")


def main():
    parser = argparse.ArgumentParser()
    # game_slug omitted entirely -> --auto mode: every game, every
    # already-played gameweek. Mirrors capture_gameweek_actuals.py's own
    # no-argument invocation from refresh_all.py's wrapup sequence.
    parser.add_argument("game_slug", nargs="?", choices=list(SOURCES.keys()))
    parser.add_argument("--gameweek", type=int)
    parser.add_argument("--from-gw", type=int)
    parser.add_argument("--to-gw", type=int)
    args = parser.parse_args()

    if args.game_slug is not None and args.gameweek is None and (args.from_gw is None or args.to_gw is None):
        parser.error("Pass either --gameweek N, or --from-gw N --to-gw M for a backfill.")

    load_env()
    conn = psycopg2.connect(os.environ["DATABASE_URL"])
    conn.autocommit = False
    cur = conn.cursor()

    try:
        if args.game_slug is None:
            for game_slug in SOURCES:
                cur.execute("select id from fantasy_games where slug = %s", (game_slug,))
                game_id = cur.fetchone()[0]
                run_for_game(cur, conn, game_slug, already_played_gameweeks(cur, game_id))
        else:
            gameweeks = [args.gameweek] if args.gameweek is not None else list(range(args.from_gw, args.to_gw + 1))
            run_for_game(cur, conn, args.game_slug, gameweeks)
    except Exception:
        conn.rollback()
        raise
    finally:
        cur.close()
        conn.close()


if __name__ == "__main__":
    main()
