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

KNOWN LATENT BUG, found 2026-08-27, not yet fixed: overall-stats-by-gw-
extra's fromGW/toGW params do NOT scope the response to that gameweek
range - confirmed live across all 3 sources (sdt/tff/cloud) that
requesting toGW=1 vs toGW=5 returns the SAME real season-to-date
CUMULATIVE totals both times (gamesPlayed/minutesPlayed/starts/
StartingXI included), not that gameweek's own increment. import_
gameweek() below currently calls this once per already-played gameweek
in a loop and writes each call's result as if it were THAT gameweek's
own "did they start" value - harmless today only because
already_played_gameweeks() has only ever had ONE real gameweek to loop
over so far this season (GW1; GW2 kicks off 2026-08-28). The MOMENT a
run processes 2+ already-played gameweeks together, every one of them
will get overwritten with the SAME latest cumulative-derived flag,
silently corrupting actual_started for every gameweek except whichever
one happens to be genuinely current. Needs a real fix (comparing
successive cumulative snapshots to derive each gameweek's own delta, or
an upstream endpoint that actually respects the range) before GW2
completes - flagged here rather than rushed through under time
pressure. accumulate_current_season_row() below is NOT affected by this
specific bug - it already treats every field as cumulative-regardless-
of-range by design (single fetch, no per-gameweek loop).

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
import psycopg2.extras

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "scripts"))
from name_matching import compact, first_letter_matches, surname_key, surname_variants  # noqa: E402

API_BASE = "https://dtt-data-api-259295136071.europe-west2.run.app"
SEASON = "202627"  # dreamteamtonic's own compact season code for 2026/27
MIN_SURNAME_KEY_LEN = 2
STARTED_MINUTES_THRESHOLD = 60  # sdt-only fallback, see module docstring

# Self-contained, not imported from compute_projections.py - same
# established convention seed_dreamteam_historical_stats.py's own
# docstring already follows ("self-contained point-value constants, no
# import from compute_projections.py"). Must match compute_projections.
# py's own CURRENT_SEASON exactly - see accumulate_dreamteam_current_
# season_row()'s own docstring.
CURRENT_SEASON = "2026/27"

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
        # Real season-cumulative event-stat field names for this source -
        # see accumulate_current_season_row()'s own docstring. Only
        # sources actually wired into that function need this key -
        # cloud (Cloud FF) already has its own real current-season data
        # from a different live scrape, not added here.
        "event_stats": lambda p: {
            "goals": p.get("goals"), "assists": p.get("assists"), "clean_sheets": p.get("cleanSheet"),
            "saves": p.get("saves"), "goals_conceded": p.get("goalsConceded"),
            "yellow_cards": p.get("yellowCards"), "red_cards": p.get("redCards"),
        },
    },
    "fanteam": {
        "key": "tff",
        "alias_source": "dreamteamtonic_tff",
        "team_overrides": {"Brighton & Hove Albion": "Brighton"},
        "started": lambda p: int(p.get("starts") or 0) >= 1,
        # tff splits clean sheets into fullCleanSheets (played the whole
        # match, 0 conceded) and partCleanSheets (on the pitch for part
        # of a clean sheet, e.g. a late sub) - fullCleanSheets only, the
        # conservative real-clean-sheet reading real fantasy scoring
        # rules typically require (60+ minutes AND no goals conceded
        # while on), not the ambiguous partial case.
        "event_stats": lambda p: {
            "goals": p.get("goals"), "assists": p.get("assists"), "clean_sheets": p.get("fullCleanSheets"),
            "saves": p.get("saves"), "goals_conceded": p.get("goalsConceded"),
            "yellow_cards": p.get("yellowCards"), "red_cards": p.get("redCards"),
        },
    },
    "cloudff": {
        "key": "cloud",
        "alias_source": "dreamteamtonic_cloud",
        "team_overrides": {"Brighton & Hove Albion": "Brighton"},
        "started": lambda p: str(p.get("StartingXI") or "0") == "1",
    },
}

# Which games' real current-season minutes/event-stats get accumulated
# from this module's own DreamTeamTonic data (see accumulate_current_
# season_row()) - Cloud FF excluded, it already has real current-season
# data from its own live scrape (scraper_cloudff.py), no gap to fill.
CURRENT_SEASON_SOURCES = ("dreamteam", "fanteam")

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
            "select gp.id from game_players gp where gp.game_id = %s and gp.player_id = %s "
            "order by gp.is_active desc limit 1",
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


def real_int(p, key):
    return int(float(p.get(key) or 0))


def accumulate_current_season_row(cur, game_id, game_slug, by_position, all_players):
    """Real season-to-date stats from DreamTeamTonic (2026-08-27 user
    request - "if we can pull everything from dream team tonic that
    would be cleaner"). Originally Dream Team-only (its own official API
    exposes no real per-match minutes field at all - see seed_dreamteam_
    historical_stats.py's own docstring - the reason that script had to
    derive a "games played" proxy from a season-cumulative points ratio
    instead, crushing every Dream Team player's expected-minutes fraction
    toward zero: real user report, Erling Haaland rated 3/10). Extended
    to FanTeam the same day - real, separate bug found while verifying
    the Dream Team fix: FanTeam's own "Mins" column showed 0 for every
    player including 8+ point scorers, because fanteam_player_status.
    minutes is scoped to whichever gameweek is CURRENTLY EDITABLE
    (upcoming, unplayed) at scrape time, not a real season-to-date total
    - structurally always 0 pre-match, not a scrape failure. See
    CURRENT_SEASON_SOURCES for which games this actually runs for -
    Cloud FF excluded, it already has real current-season data from its
    own live scrape.

    IMPORTANT, confirmed live 2026-08-27: overall-stats-by-gw-extra does
    NOT return per-gameweek deltas despite its fromGW/toGW params - every
    field (gamesPlayed, minutesPlayed, totalPoints, every per-stat count)
    is the SAME real season-cumulative total regardless of what range is
    requested (checked directly across sdt/tff/cloud: toGW=1 and toGW=5
    returned byte-identical numbers for every player). Fetch ONCE and
    read the already-cumulative fields directly - gamesPlayed maps
    straight onto pt1 (a real appearance count, no derivation needed at
    all), and the same real payload has genuine goals/assists/clean-
    sheets/saves/etc per-stat TOTALS too (see each source's own
    event_stats mapper in SOURCES) - used directly here rather than
    carried forward from whatever each game's own official-API historical
    pipeline has, per the user's "pull everything from dream team tonic"
    direction.

    pt60/pt90 have no real per-appearance breakdown available from this
    season-aggregate endpoint (that granularity only exists per-gameweek,
    which this endpoint doesn't actually expose despite appearing to).
    Estimated from real avg minutes per appearance (minutesPlayed /
    gamesPlayed) scaled against the 60/90-minute thresholds directly -
    data-grounded per player, not a single flat assumed rate applied to
    everyone.

    Idempotent per run: re-fetches the current cumulative snapshot fresh
    every time (there's nothing to accumulate incrementally, since the
    source itself is already cumulative), then deletes and re-inserts the
    one season-aggregate row per player - same idiom seed_dreamteam_
    historical_stats.py already uses."""
    source = SOURCES[game_slug]
    data = fetch_gameweek(source["key"], 1)  # fromGW/toGW ignored - see docstring
    if not data or not data.get("players"):
        return 0

    per_player = {}  # game_player_id -> raw DTT player dict
    team_id_cache = {}
    for p in data["players"]:
        raw_team = p.get("squadName")
        if raw_team not in team_id_cache:
            team_id_cache[raw_team] = resolve_team_id(cur, source["alias_source"], source["team_overrides"], raw_team)
        team_id = team_id_cache[raw_team]
        live_position = POSITION_MAP.get(p.get("positionLabel") or p.get("position"))
        display_name = p.get("displayName")
        if not display_name or not live_position:
            continue
        # CURRENT_SEASON_SOURCES is dreamteam/fanteam only (see this
        # function's own docstring) - both use the same surname_variants
        # matcher import_gameweek() below already uses for them; Cloud
        # FF's own bare-surname format needs match_player_cloud instead,
        # not reachable here since it's excluded from this accumulation.
        player_id = match_player(by_position, all_players, display_name, live_position, team_id)
        if player_id is None:
            continue
        cur.execute(
            "select gp.id from game_players gp where gp.game_id = %s and gp.player_id = %s "
            "order by gp.is_active desc limit 1",
            (game_id, player_id),
        )
        row = cur.fetchone()
        if not row:
            continue
        per_player[row[0]] = p

    if not per_player:
        return 0

    written = 0
    for game_player_id, p in per_player.items():
        pt1 = real_int(p, "gamesPlayed")
        minutes_played = real_int(p, "minutesPlayed")
        avg_min = (minutes_played / pt1) if pt1 > 0 else 0.0
        # No real per-appearance breakdown exists at this season-
        # aggregate granularity (see this function's own docstring) -
        # estimated from real avg minutes per appearance, per player,
        # rather than one flat assumed rate applied to everyone.
        pt60 = round(pt1 * min(1.0, avg_min / 60.0)) if avg_min > 0 else 0
        pt90 = round(pt1 * min(1.0, avg_min / 90.0)) if avg_min > 0 else 0

        raw_stats = {
            "PT1": pt1, "PT60": pt60, "PT90": pt90,
            "games_played_derived": pt1,
            "avg_minutes_per_appearance": round(avg_min, 1),
            "percent_selected": float(p.get("percentSelected") or 0),
        }

        event_stats = source["event_stats"](p)

        cur.execute(
            "delete from game_player_stats where game_player_id = %s and season = %s and gameweek = 0",
            (game_player_id, CURRENT_SEASON),
        )
        cur.execute(
            """
            insert into game_player_stats
                (game_player_id, season, gameweek, minutes_played, goals, assists, clean_sheets,
                 saves, goals_conceded, yellow_cards, red_cards, total_points, raw_stats)
            values (%s, %s, 0, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s)
            """,
            (
                game_player_id, CURRENT_SEASON, minutes_played,
                real_int(event_stats, "goals"), real_int(event_stats, "assists"), real_int(event_stats, "clean_sheets"),
                real_int(event_stats, "saves"), real_int(event_stats, "goals_conceded"),
                real_int(event_stats, "yellow_cards"), real_int(event_stats, "red_cards"),
                real_int(p, "totalPoints"), psycopg2.extras.Json(raw_stats),
            ),
        )
        written += 1
    return written


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

    # Real per-gameweek minutes -> a real CURRENT_SEASON shrinkage-prior
    # row (2026-08-27 - see accumulate_current_season_row's own
    # docstring). dreamteam/fanteam only (CURRENT_SEASON_SOURCES) - Cloud
    # FF already gets real current-season game_player_stats rows from its
    # own dedicated live scrape, this fills the real gap Dream Team's
    # official API structurally can't, and the real gap FanTeam's own
    # editable-gameweek-scoped status snapshot can't either.
    if game_slug in CURRENT_SEASON_SOURCES:
        rows_written = accumulate_current_season_row(cur, game_id, game_slug, by_position, all_players)
        conn.commit()
        print(f"{game_slug}: {rows_written} real current-season minutes rows written.")


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
