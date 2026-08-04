"""
import_dreamteam.py
----------------------
Loads live Dream Team data (scraper_dreamteam.py output) into Supabase,
reusing the same shared players/teams tables every other game already
uses. Dream Team previously only had a one-off historical CSV seed
(import_historical_data.py, external_id = last season's numeric
playerId) - this is its first live re-sync, so existing game_players
rows are re-matched by name+position (same technique as
import_fanteam_live.py, see below) rather than by external_id, which
naturally migrates each matched row from the old numeric scheme to the
new live API's stable uuid `id` going forward.

Team resolution: the live API's teamName strings (e.g. "Chelsea FC",
"AFC Bournemouth") are Dream Team's own display names, not this
project's canonical teams.name spelling - DREAMTEAM_TEAM_ALIASES below
maps each of the real 20 real 2026/27 clubs (extracted live, all 20
confirmed to already exist in `teams`) to the canonical name.

Position resolution: the live API's "STR" maps to this shared schema's
"FWD" (confirmed live: `players.position` has zero "STR" rows, 107
"FWD" - Dream Team's OWN game_players.position_code historically uses
"STR" though, so that native code is still what gets written there,
only the canonical `players.position` bucket lookup below is
translated). GK/DEF/MID need no translation.

Player matching: bucketed by position only, NOT team - confirmed live
that `players.team_id` for several real Dream Team players (Alejandro
Garnacho, Issa Diop) is stale (last season's club), so scoping the
match to the OLD team would silently miss a player who's genuinely
still the same real person at a new club - exactly the same staleness
gap import_fanteam_live.py already solved. Ported here rather than
reinvented: same surname-key matching, same exact-match/first-initial
tiebreaks, same team-based disambiguation for genuine same-surname
different-people collisions, and the same DEBOUNCED team_id update
(players.pending_team_id/pending_team_seen_at + a 24h cooldown against
oscillation, see TEAM_CHANGE_COOLDOWN) - a confident name match here
corrects a stale team_id, but only once the same new team has been
seen on two separate imports, never on the first sight of a mismatch.
No match at all -> logged and skipped, never guessed.

Gameweek calendar: Dream Team's own real gameweek numbers aren't
fetchable yet - the live gaming-api.dreamteamfc.com backend's homefeed
endpoint (confirmed real, reachable with an anonymous token) returns an
empty feed because the 2026/27 game itself hasn't launched ("Coming
soon" on the real site as of 2026-08-04). But Dream Team's own rules
(section 1.2.5.1) define GW1 as starting at the first Eligible Match's
kickoff and every later gameweek as one real EPL round - exactly what
FanTeam's own game_fixture_gameweeks already encodes for these same 380
real soccer_epl fixtures (confirmed live: FanTeam's GW1 rows' earliest
kickoff is 2026-08-21 19:00 UTC, matching Dream Team's real "8pm on 21
August 2026" rule exactly). So this copies FanTeam's real
(fixture_id, gameweek) pairs onto dreamteam's game_id rather than
re-deriving them - not a match-day split like Cloud FF's own scheme
(no per-match-day captain concept in Dream Team), a real gameweek is
the whole round.

RUN:
    python3 import_dreamteam.py
"""
import json
import os
import sys
from datetime import datetime, timedelta, timezone
from pathlib import Path

import psycopg2
import psycopg2.extras

ROOT = Path(__file__).resolve().parent
sys.path.insert(0, str(ROOT / "scripts"))
from activity_log import log_event  # noqa: E402
from name_matching import compact, surname_key  # noqa: E402

# Dream Team's own display name -> canonical teams.name. Extracted live
# from the real players endpoint (20/20 real 2026/27 EPL clubs, all
# confirmed to already exist in `teams` by exact name).
DREAMTEAM_TEAM_ALIASES = {
    "AFC Bournemouth": "Bournemouth",
    "Arsenal FC": "Arsenal",
    "Aston Villa FC": "Aston Villa",
    "Brentford FC": "Brentford",
    "Brighton & Hove Albion FC": "Brighton",
    "Chelsea FC": "Chelsea",
    "Coventry City FC": "Coventry City",
    "Crystal Palace FC": "Crystal Palace",
    "Everton FC": "Everton",
    "Fulham FC": "Fulham",
    "Hull City AFC": "Hull City",
    "Ipswich Town FC": "Ipswich Town",
    "Leeds United FC": "Leeds United",
    "Liverpool FC": "Liverpool",
    "Manchester City FC": "Manchester City",
    "Manchester United FC": "Manchester United",
    "Newcastle United FC": "Newcastle United",
    "Nottingham Forest FC": "Nottingham Forest",
    "Sunderland AFC": "Sunderland",
    "Tottenham Hotspur FC": "Tottenham Hotspur",
}

# Dream Team's own position code -> shared players.position vocabulary
# (confirmed live - see module docstring). Codes not listed here already
# match (GK/DEF/MID).
POSITION_CANONICAL_MAP = {"STR": "FWD"}

# Matches import_fanteam_live.py's own constant/reasoning exactly - see
# that file's TEAM_CHANGE_COOLDOWN comment for the real Kamara/Ba/
# Manzambi oscillation cases this guards against. Deliberately the same
# value since it's the same shared `players` table and the same kind of
# payload-noise risk, not a Dream Team-specific tuning.
TEAM_CHANGE_COOLDOWN = timedelta(hours=24)


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


def canonical_position(position: str) -> str:
    return POSITION_CANONICAL_MAP.get(position, position)


def resolve_team_id(cur, team_id_cache, team_name: str):
    if team_name in team_id_cache:
        return team_id_cache[team_name]
    canonical = DREAMTEAM_TEAM_ALIASES.get(team_name)
    if canonical is None:
        raise SystemExit(f"No DREAMTEAM_TEAM_ALIASES entry for team name {team_name!r} - a new club, or the mapping needs extending.")
    cur.execute("select id from teams where name = %s", (canonical,))
    row = cur.fetchone()
    if not row:
        raise SystemExit(f"No canonical team found for Dream Team club {team_name!r} (mapped to {canonical!r})")
    team_id_cache[team_name] = row[0]
    return row[0]


def import_players(cur, game_id, players_data):
    cur.execute("select id, full_name, position, team_id, pending_team_id from players")
    by_position: dict[str, list[tuple]] = {}
    all_players: list[tuple] = []
    pending_team_by_id: dict[int, int] = {}
    position_by_id: dict[int, str] = {}
    for pid, full_name, position, team_id, pending_team_id in cur.fetchall():
        by_position.setdefault(position, []).append((pid, full_name, team_id))
        all_players.append((pid, full_name, team_id))
        pending_team_by_id[pid] = pending_team_id
        position_by_id[pid] = position

    cur.execute("select id, name from teams")
    team_name_by_id = {tid: name for tid, name in cur.fetchall()}

    # Game-independent (activity_log isn't scoped to one fantasy game) -
    # a transfer is a real-world fact regardless of which game's importer
    # first observes it, same reasoning as import_fanteam_live.py's own
    # last_team_change_by_id lookup.
    cur.execute(
        "select (details->>'player_id')::bigint as player_id, max(created_at) as last_changed_at "
        "from activity_log where event_type = 'team_changed' group by (details->>'player_id')::bigint"
    )
    last_team_change_by_id: dict[int, datetime] = {row[0]: row[1] for row in cur.fetchall()}

    team_id_cache: dict[str, int] = {}
    matched, created, ambiguous, updated_team, status_written, new_canonical_player = 0, 0, 0, 0, 0, 0
    seen_external_ids = set()

    for p in players_data:
        live_position = canonical_position(p["position"])
        live_team_id = resolve_team_id(cur, team_id_cache, p["teamName"])
        live_full_name = f"{p['firstName']} {p['lastName']}".strip()
        live_compact = compact(live_full_name)
        live_surname_key = surname_key(live_full_name)

        candidates = [
            (pid, name, team_id)
            for pid, name, team_id in by_position.get(live_position, [])
            if live_compact.endswith(surname_key(name)) or (live_surname_key and compact(name).endswith(live_surname_key))
        ]

        # Position-bucketing above is an optimisation, not an identity
        # rule - a player's listed position can genuinely be
        # reclassified (real cases confirmed live for FanTeam: Ethan
        # Ampadu DEF->MID, Evann Guessand FWD->MID, and others - see
        # import_fanteam_live.py's own comment). Only runs when the
        # position bucket found nothing, so the common case (position
        # unchanged) never pays this extra scan.
        if not candidates:
            candidates = [
                (pid, name, team_id)
                for pid, name, team_id in all_players
                if live_compact.endswith(surname_key(name)) or (live_surname_key and compact(name).endswith(live_surname_key))
            ]

        if len(candidates) > 1:
            exact = [c for c in candidates if compact(c[1]) == live_compact]
            if len(exact) == 1:
                candidates = exact

        if len(candidates) > 1:
            live_initial = live_full_name[0].lower()
            narrowed = [c for c in candidates if c[1][0].lower() == live_initial]
            if len(narrowed) == 1:
                candidates = narrowed

        # A lone candidate still needs the first-initial check - the
        # surname-suffix rule above is a literal string test with no
        # first-name awareness, so two genuinely different real people
        # who share a surname would silently merge the moment only one
        # of them has ever been imported (same reasoning as
        # import_fanteam_live.py's own Kamara-collision guard).
        if len(candidates) == 1 and compact(candidates[0][1]) != live_compact:
            if candidates[0][1][0].lower() != live_full_name[0].lower():
                candidates = []

        # Last resort for a genuine same-surname collision: prefer
        # whichever candidate's stored team already matches the live
        # team - team can be stale after a transfer, but for
        # disambiguating between distinct same-named players it's still
        # a reasonable signal.
        if len(candidates) > 1:
            team_matches = [c for c in candidates if c[2] == live_team_id]
            if len(team_matches) == 1:
                candidates = team_matches

        if len(candidates) > 1:
            ambiguous += 1
            print(f"  [ambiguous] {p['displayName']} ({p['position']}, {p['teamName']}) -> {[c[1] for c in candidates]}")
            continue

        if candidates:
            player_id, canonical_name, canonical_team_id = candidates[0]
            matched += 1
        else:
            # Genuinely no existing candidate anywhere - the surname-key
            # check above already fell back to every position bucket
            # (all_players) once the position-scoped bucket came up
            # empty, so a true zero here means the name matches nothing
            # at all in the canonical table. A real new signing or a
            # fringe/academy player never previously seen by any game's
            # import. Same philosophy as import_fanteam_live.py's own
            # unmatched branch: create the canonical row rather than
            # silently dropping a real player, since the whole point of
            # this import is "populate with the new players".
            cur.execute(
                "insert into players (full_name, team_id, position) values (%s, %s, %s) returning id",
                (live_full_name, live_team_id, live_position),
            )
            player_id = cur.fetchone()[0]
            canonical_name = live_full_name
            canonical_team_id = live_team_id
            new_canonical_player += 1
            log_event(
                cur, "player_added", f"{canonical_name} added as a new player (Dream Team, {p['position']})",
                game_id=game_id, details={"player_id": player_id, "position": live_position, "team_id": live_team_id},
            )

        if position_by_id.get(player_id) != live_position:
            cur.execute("update players set position = %s where id = %s", (live_position, player_id))
            position_by_id[player_id] = live_position

        if canonical_team_id != live_team_id:
            debounce_confirmed = pending_team_by_id.get(player_id) == live_team_id
            last_changed_at = last_team_change_by_id.get(player_id)
            in_cooldown = (
                last_changed_at is not None
                and datetime.now(timezone.utc) - last_changed_at < TEAM_CHANGE_COOLDOWN
            )
            if debounce_confirmed and in_cooldown:
                print(
                    f"  [cooldown] {canonical_name}: matched {team_name_by_id.get(live_team_id, live_team_id)} twice, "
                    f"but a team_changed commit happened within the last {TEAM_CHANGE_COOLDOWN} - holding, not recommitting yet."
                )
                cur.execute(
                    "update players set pending_team_id = %s, pending_team_seen_at = now() where id = %s",
                    (live_team_id, player_id),
                )
            elif debounce_confirmed:
                cur.execute(
                    "update players set team_id = %s, pending_team_id = null, pending_team_seen_at = null where id = %s",
                    (live_team_id, player_id),
                )
                updated_team += 1
                old_team_name = team_name_by_id.get(canonical_team_id, "an unknown club")
                new_team_name = team_name_by_id.get(live_team_id, "an unknown club")
                log_event(
                    cur, "team_changed", f"{canonical_name} moved from {old_team_name} to {new_team_name}",
                    game_id=game_id, details={"player_id": player_id, "old_team_id": canonical_team_id, "new_team_id": live_team_id},
                )
            else:
                cur.execute(
                    "update players set pending_team_id = %s, pending_team_seen_at = now() where id = %s",
                    (live_team_id, player_id),
                )
        elif pending_team_by_id.get(player_id) is not None:
            # Live team now agrees with what's already stored - clear a
            # stale pending flag from an earlier blip that never got
            # confirmed on a second run.
            cur.execute("update players set pending_team_id = null, pending_team_seen_at = null where id = %s", (player_id,))

        cur.execute("select id from game_players where game_id = %s and player_id = %s", (game_id, player_id))
        row = cur.fetchone()
        external_id = p["id"]
        seen_external_ids.add(external_id)
        # Dream Team's own native position code (e.g. "STR"), not the
        # canonical-translated one used only for matching above - this
        # column feeds the rest of the existing Dream Team pipeline
        # (game_scoring_rules, compute_projections.py), which already
        # expects "STR".
        native_position = p["position"]
        if row:
            game_player_id = row[0]
            cur.execute(
                "update game_players set external_id = %s, position_code = %s, price = %s, is_active = true, updated_at = now() where id = %s",
                (external_id, native_position, p["price"], game_player_id),
            )
        else:
            log_event(
                cur, "player_added", f"{canonical_name} added to Dream Team ({native_position})",
                game_id=game_id, details={"player_id": player_id, "position": native_position, "team_id": live_team_id},
            )
            cur.execute(
                """
                insert into game_players (game_id, player_id, external_id, position_code, price, is_active)
                values (%s, %s, %s, %s, %s, true)
                on conflict (game_id, external_id) do update
                    set player_id = excluded.player_id, position_code = excluded.position_code, price = excluded.price,
                        is_active = true, updated_at = now()
                """,
                (game_id, player_id, external_id, native_position, p["price"]),
            )
            created += 1
        status_written += 1

    print(
        f"Players: {matched} matched, {new_canonical_player} new canonical players created, "
        f"{ambiguous} unmatched/ambiguous (skipped). {status_written} game_players rows written "
        f"({created} newly linked). {updated_team} team changes committed."
    )

    cur.execute("select external_id from game_players where game_id = %s and is_active = true", (game_id,))
    currently_active = {row[0] for row in cur.fetchall()}
    stale_ids = currently_active - seen_external_ids
    if stale_ids:
        cur.execute(
            "update game_players set is_active = false, updated_at = now() where game_id = %s and external_id = any(%s)",
            (game_id, list(stale_ids)),
        )
        print(f"Deactivated {len(stale_ids)} players no longer in Dream Team's live list.")


def sync_gameweek_calendar(cur, game_id):
    """Copy FanTeam's real (fixture_id, gameweek) pairs onto Dream Team -
    see module docstring for why this is a copy, not a fresh scrape."""
    cur.execute(
        """
        insert into game_fixture_gameweeks (game_id, fixture_id, gameweek)
        select %s, gfg.fixture_id, gfg.gameweek
        from game_fixture_gameweeks gfg
        join fantasy_games fanteam on fanteam.id = gfg.game_id and fanteam.slug = 'fanteam'
        on conflict (game_id, fixture_id) do update set gameweek = excluded.gameweek
        """,
        (game_id,),
    )
    print(f"Gameweek calendar: {cur.rowcount} fixture-gameweek mappings synced from FanTeam's real calendar.")


def main():
    load_env()
    conn = psycopg2.connect(os.environ["DATABASE_URL"])
    conn.autocommit = False
    cur = conn.cursor()

    try:
        cur.execute("select id from fantasy_games where slug = 'dreamteam'")
        row = cur.fetchone()
        if not row:
            raise SystemExit("No fantasy_games row for slug='dreamteam'.")
        game_id = row[0]

        players_data = json.loads((ROOT / "dreamteam_players_raw.json").read_text(encoding="utf-8"))

        import_players(cur, game_id, players_data)
        sync_gameweek_calendar(cur, game_id)

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
