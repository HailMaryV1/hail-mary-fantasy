"""
import_fanteam_golf.py
------------------------
Loads one FanTeam golf tournament (scraper_fanteam_golf.py's output) into
Supabase: the tournament itself, every golfer in its pool, and their
price/lineup/status/stats for THIS specific tournament.

Golfer matching: unlike import_fanteam_live.py's football importer
(bucketed by team+position - two strong disambiguating signals), a golfer
has neither. The API's realPlayer.sportyId (ScoutGG's own internal
player ID) is the strongest available signal and IS stable across
tournaments, so it's tried first - once a golfer has been imported once,
every later tournament matches them instantly and unambiguously via
sportyId, no name-guessing needed. Only a genuinely new golfer (never
seen in any previous tournament import) falls through to name matching:
exact full-name match, then a compact-name fuzzy fallback (same compact()
technique match_players.py/import_fanteam_live.py already use). Multiple
fuzzy candidates are flagged ambiguous and skipped - surfaced in the
import summary for manual review - rather than silently guessed, since
there's no team/position to narrow the field the way football's importer
can.

Tournament-scoped, not mutate-in-place: golf_tournament_entries is keyed
unique(tournament_id, game_player_id) - re-running this script against
the same tournament always upserts that tournament's own rows only, never
touching another tournament's history (see migration 0045's docstring).
Every price/lineup/status/stat change on a re-run is diffed against the
existing row and logged via activity_log.py, same discipline
import_fanteam_live.py already applies to football price/status changes.

RUN:
    python3 scraper_fanteam_golf.py <tournament_id_or_url>
    python3 import_fanteam_golf.py
"""

import json
import os
import re
import sys
from datetime import datetime, timezone
from pathlib import Path

import psycopg2
import psycopg2.extras

ROOT = Path(__file__).resolve().parent
sys.path.insert(0, str(ROOT / "scripts"))
from activity_log import log_event  # noqa: E402

RAW_FILE = ROOT / "golf_tournament_raw.json"

# The ~10 avgStats keys confirmed present for nearly every golfer (136/140
# in the reference pool) - promoted to typed columns. Everything else
# (top10/15/20/25/30/40/50/60, rank1-9, holeInOne, tripleBogeyOrWorse,
# threeConsecutiveBirdies, allFourSub70, remainingHoles, ...) stays in the
# avg_stats/total_stats jsonb columns - genuinely sparse, varies per
# golfer, not worth a fixed column each.
CORE_STAT_COLUMNS = {
    "made_cut_rate": "madeCut",
    "birdie_rate": "birdie",
    "bogey_rate": "bogey",
    "eagle_rate": "eagle",
    "double_bogey_rate": "doubleBogey",
    "bounce_back_rate": "bounceBack",
    "score_avg": "score",
    "total_score_avg": "totalScore",
}

# match_count/start_count are deliberately sourced from totalStats, not
# avgStats - confirmed live that avgStats.matchCount is always 1 across
# every golfer in a real pool (an artifact of however FanTeam computes
# that blob, not a real sample size), while totalStats.matchCount is the
# real number of tournaments behind the averages above (12-21 in the
# reference pool). Using avgStats.matchCount as the shrinkage-reliability
# signal would over-shrink every golfer's projection toward the field
# average regardless of how established they actually are - caught by
# inspecting Scottie Scheffler's own make-cut probability coming out
# suspiciously low during Phase 2 verification.
TOTAL_STAT_COLUMNS = {
    "match_count": "matchCount",
    "start_count": "startCount",
}


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


def compact(name: str) -> str:
    return re.sub(r"[^a-z]", "", name.lower())


def surname_key(full_name: str) -> str:
    # Same technique import_fanteam_live.py uses for football.
    if ". " in full_name:
        return compact(full_name.split(". ", 1)[1])
    return compact(full_name.split(" ")[-1])


def golfer_full_name(real_player: dict) -> str:
    # Same mononym handling as import_fanteam_live.py - lastName null
    # means customName (or firstName alone) is the real display name.
    if not real_player.get("lastName"):
        return real_player.get("customName") or real_player["firstName"]
    return f"{real_player['firstName']} {real_player['lastName']}".strip()


def parse_dt(value):
    return datetime.fromisoformat(value) if value else None


def upsert_tournament(cur, game_id, data):
    tournament = data["tournament"]
    match_collection = data.get("matchCollection") or {}
    seasons = data.get("seasons") or []
    season = seasons[0] if seasons else {}

    fanteam_tournament_id = str(tournament["id"])
    fanteam_game_id = str(tournament.get("gameId") or match_collection.get("id") or "")
    name = tournament["name"]
    tour = (season.get("league") or {}).get("name")
    season_year = season.get("season")
    event_number = data.get("round")
    game_scope = match_collection.get("gameScope")
    registration_time = parse_dt(tournament.get("registrationTime"))
    start_time = parse_dt(match_collection.get("startTime"))
    end_time = parse_dt(match_collection.get("endTime"))

    now = datetime.now(timezone.utc)
    if start_time and now < start_time:
        status = "upcoming"
    elif end_time and now > end_time:
        status = "completed"
    else:
        status = "live" if start_time else "upcoming"

    raw = {"tournament": tournament, "matchCollection": match_collection, "seasons": seasons, "round": data.get("round")}

    cur.execute(
        """
        insert into golf_tournaments (
            game_id, fanteam_tournament_id, fanteam_game_id, name, tour, season_year,
            event_number, game_scope, registration_time, start_time, end_time, status, raw, updated_at
        ) values (%s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, now())
        on conflict (fanteam_tournament_id) do update set
            fanteam_game_id = excluded.fanteam_game_id, name = excluded.name, tour = excluded.tour,
            season_year = excluded.season_year, event_number = excluded.event_number,
            game_scope = excluded.game_scope, registration_time = excluded.registration_time,
            start_time = excluded.start_time, end_time = excluded.end_time, status = excluded.status,
            raw = excluded.raw, updated_at = now()
        returning id
        """,
        (
            game_id, fanteam_tournament_id, fanteam_game_id, name, tour, season_year,
            event_number, game_scope, registration_time, start_time, end_time, status,
            json.dumps(raw),
        ),
    )
    return cur.fetchone()[0]


def resolve_golfer(sporty_id_cache, golfers, sporty_id, full_name):
    """golfers: list of (id, full_name) for every golfer known BEFORE
    this import run started - flat, not bucketed (unlike football's
    by-position buckets - golf has no position to bucket by). Deliberately
    frozen for the whole run: every golfer in one tournament's pool is,
    by definition, a distinct real person (FanTeam never lists the same
    realPlayerId twice in one pull), so a golfer created earlier in THIS
    run must never be a match candidate for a later one in the same
    run - that would silently conflate two different real golfers who
    simply share a surname substring. Only cross-tournament (this run
    vs. every previous run) matching is ever valid."""
    # 1. Stable-ID match - once a golfer's been imported once, every later
    # tournament resolves them here, no name-guessing involved.
    if sporty_id and sporty_id in sporty_id_cache:
        return sporty_id_cache[sporty_id], "sporty_id"

    live_compact = compact(full_name)

    # 2. Exact compact-name match.
    exact = [gid for gid, name in golfers if compact(name) == live_compact]
    if len(exact) == 1:
        return exact[0], "exact_name"
    if len(exact) > 1:
        return None, "ambiguous"

    # 3. Fuzzy fallback - live name ends with a candidate's surname, same
    # technique import_fanteam_live.py uses for football, minus the
    # team/position bucketing it has and golf doesn't - genuinely weaker,
    # flagged as such in the module docstring.
    candidates = [gid for gid, name in golfers if live_compact.endswith(surname_key(name))]
    if len(candidates) == 1:
        return candidates[0], "fuzzy_name"
    if len(candidates) > 1:
        return None, "ambiguous"

    return None, "new"


def import_tournament_players(cur, game_id, tournament_id, data):
    # Every golfer + game_players row seen so far, for matching -
    # golfers table is small (one row per real-world golfer ever
    # imported), cheap to load whole.
    cur.execute("select id, sporty_id, full_name from golfers")
    sporty_id_cache = {}
    golfers: list[tuple[int, str]] = []
    for gid, sporty_id, full_name in cur.fetchall():
        if sporty_id:
            sporty_id_cache[sporty_id] = gid
        golfers.append((gid, full_name))

    cur.execute("select golfer_id, id from game_players where game_id = %s and golfer_id is not null", (game_id,))
    game_player_by_golfer = {golfer_id: gp_id for golfer_id, gp_id in cur.fetchall()}

    cur.execute(
        "select game_player_id, price, lineup, status, form, total_points from golf_tournament_entries where tournament_id = %s",
        (tournament_id,),
    )
    existing_entries = {
        gp_id: {"price": price, "lineup": lineup, "status": status, "form": form, "total_points": total_points}
        for gp_id, price, lineup, status, form, total_points in cur.fetchall()
    }

    matched_by_id, matched_by_name, created, ambiguous_list = 0, 0, 0, []
    entries_written, changes_detected = 0, 0

    for pc in data["playerChoices"]:
        real_player = pc["realPlayer"]
        sporty_id = real_player.get("sportyId")
        full_name = golfer_full_name(real_player)

        golfer_id, method = resolve_golfer(sporty_id_cache, golfers, sporty_id, full_name)

        if golfer_id is None and method == "ambiguous":
            ambiguous_list.append(full_name)
            continue

        if golfer_id is None:
            cur.execute(
                "insert into golfers (full_name, sporty_id) values (%s, %s) returning id",
                (full_name, sporty_id),
            )
            golfer_id = cur.fetchone()[0]
            # Deliberately NOT appended to sporty_id_cache/golfers - see
            # resolve_golfer's docstring: a golfer created earlier in
            # THIS run must never match-candidate a later one in the same
            # tournament pool.
            created += 1
            log_event(
                cur, "player_added", f"{full_name} added as a new golfer (FanTeam Golf)",
                game_id=game_id, details={"golfer_id": golfer_id, "tournament_id": tournament_id},
            )
        elif method == "sporty_id":
            matched_by_id += 1
        else:
            matched_by_name += 1

        # game_players: one stable row per (game, golfer) across every
        # tournament - external_id is FanTeam's realPlayerId (stable),
        # price is a "last-seen" convenience cache (golf_tournament_entries
        # is the authoritative per-tournament source - see migration
        # 0045's docstring). position_code has no real golf meaning
        # (free-text column, not CHECK-constrained like players.position)
        # so it's just a constant marker.
        external_id = str(pc["realPlayerId"])
        price = pc.get("price")
        existing_gp_id = game_player_by_golfer.get(golfer_id)
        if existing_gp_id:
            game_player_id = existing_gp_id
            cur.execute(
                "update game_players set external_id = %s, price = %s, is_active = true, updated_at = now() where id = %s",
                (external_id, price, game_player_id),
            )
        else:
            cur.execute(
                """
                insert into game_players (game_id, golfer_id, external_id, position_code, price, is_active)
                values (%s, %s, %s, 'GOLF', %s, true)
                returning id
                """,
                (game_id, golfer_id, external_id, price),
            )
            game_player_id = cur.fetchone()[0]
            game_player_by_golfer[golfer_id] = game_player_id

        avg_stats = pc.get("avgStats") or {}
        total_stats = pc.get("totalStats") or {}
        core_values = {col: avg_stats.get(key) for col, key in CORE_STAT_COLUMNS.items()}
        core_values.update({col: total_stats.get(key) for col, key in TOTAL_STAT_COLUMNS.items()})

        new_state = {
            "price": price, "lineup": pc.get("lineup"), "status": pc.get("status"),
            "form": pc.get("form"), "total_points": pc.get("totalPoints"),
        }
        old_state = existing_entries.get(game_player_id)

        def field_changed(key, numeric=False):
            old_v, new_v = old_state[key], new_state[key]
            if old_v is None and new_v is None:
                return False
            if numeric:
                return float(old_v or 0) != float(new_v or 0)
            return old_v != new_v

        entry_changed = old_state and (
            field_changed("price", numeric=True)
            or field_changed("form", numeric=True)
            or field_changed("total_points", numeric=True)
            or field_changed("lineup")
            or field_changed("status")
        )
        if entry_changed:
            changes_detected += 1
            log_event(
                cur, "score_changed", f"{full_name}: {old_state} -> {new_state}",
                game_id=game_id, game_player_id=game_player_id,
                details={"tournament_id": tournament_id, "old": old_state, "new": new_state},
            )

        cur.execute(
            """
            insert into golf_tournament_entries (
                tournament_id, game_player_id, external_player_id, price, lineup, status, form,
                total_points, last_points, active,
                made_cut_rate, birdie_rate, bogey_rate, eagle_rate, double_bogey_rate, bounce_back_rate,
                score_avg, total_score_avg, match_count, start_count,
                avg_stats, total_stats, raw, updated_at
            ) values (
                %(tournament_id)s, %(game_player_id)s, %(external_player_id)s, %(price)s, %(lineup)s, %(status)s, %(form)s,
                %(total_points)s, %(last_points)s, %(active)s,
                %(made_cut_rate)s, %(birdie_rate)s, %(bogey_rate)s, %(eagle_rate)s, %(double_bogey_rate)s, %(bounce_back_rate)s,
                %(score_avg)s, %(total_score_avg)s, %(match_count)s, %(start_count)s,
                %(avg_stats)s, %(total_stats)s, %(raw)s, now()
            )
            on conflict (tournament_id, game_player_id) do update set
                external_player_id = excluded.external_player_id, price = excluded.price, lineup = excluded.lineup,
                status = excluded.status, form = excluded.form, total_points = excluded.total_points,
                last_points = excluded.last_points, active = excluded.active,
                made_cut_rate = excluded.made_cut_rate, birdie_rate = excluded.birdie_rate, bogey_rate = excluded.bogey_rate,
                eagle_rate = excluded.eagle_rate, double_bogey_rate = excluded.double_bogey_rate,
                bounce_back_rate = excluded.bounce_back_rate, score_avg = excluded.score_avg,
                total_score_avg = excluded.total_score_avg, match_count = excluded.match_count, start_count = excluded.start_count,
                avg_stats = excluded.avg_stats, total_stats = excluded.total_stats, raw = excluded.raw, updated_at = now()
            """,
            {
                "tournament_id": tournament_id, "game_player_id": game_player_id,
                "external_player_id": external_id, "price": price,
                "lineup": pc.get("lineup"), "status": pc.get("status"), "form": pc.get("form"),
                "total_points": pc.get("totalPoints"), "last_points": pc.get("lastPoints"),
                "active": pc.get("active", True),
                **core_values,
                "avg_stats": json.dumps(avg_stats), "total_stats": json.dumps(total_stats), "raw": json.dumps(pc),
            },
        )
        entries_written += 1

    print(f"Golfers: {matched_by_id} matched by sporty_id, {matched_by_name} matched by name, {created} newly created.")
    if ambiguous_list:
        print(f"  [ambiguous - skipped, needs manual review] {ambiguous_list}")
    print(f"Tournament entries: {entries_written} written, {changes_detected} price/lineup/status/points change(s) detected.")


def main():
    if not RAW_FILE.exists():
        raise SystemExit(f"{RAW_FILE} not found - run scraper_fanteam_golf.py <tournament_id_or_url> first.")

    load_env()
    conn = psycopg2.connect(os.environ["DATABASE_URL"])
    conn.autocommit = False
    cur = conn.cursor()

    try:
        cur.execute("select id from fantasy_games where slug = 'fanteam-golf'")
        row = cur.fetchone()
        if not row:
            raise SystemExit("fantasy_games row for 'fanteam-golf' not found - run migration 0045 first.")
        game_id = row[0]

        data = json.loads(RAW_FILE.read_text(encoding="utf-8"))
        tournament_id = upsert_tournament(cur, game_id, data)
        print(f"Tournament: \"{data['tournament']['name']}\" (id {tournament_id}, FanTeam id {data['tournament']['id']}).")

        import_tournament_players(cur, game_id, tournament_id, data)

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
