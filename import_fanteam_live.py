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
pair + competition + season, NOT kickoff time - see 2026-08-27 fix
below) instead of creating duplicates, and records the real gameweek
number via game_fixture_gameweeks - replacing the period_start/
period_end placeholder with FanTeam's actual calendar. Any fixture not
already present (Odds API hasn't reached that far ahead yet) gets
created fresh from FanTeam's own data.

2026-08-27 fix: matching used to require kickoff_at to match EXACTLY,
which broke the moment a match got a real TV-picked kickoff slot after
this table's own Odds-API-sourced row was created with the original
placeholder time - the exact-match lookup then found nothing and
inserted a whole SECOND fixture row for the same real match (confirmed
live: 25 Premier League fixtures duplicated this way, all traced to
one 2026-08-17 reschedule batch). The same two teams only play each
other once at a given venue per season in a normal league competition,
so (home, away, competition, season) alone is the real natural key -
kickoff_at is just a fact about that row, refreshed in place below
whenever it's moved rather than used to find the row.

Players: FanTeam's live API uses a different internal ID scheme than
last season's CSV (confirmed: CSV ids like 1677501 vs live ids like
4700617 - a different numbering system, likely a platform migration).
So this matches live players to existing canonical players by name +
position (same surname-matching heuristic as match_players.py) -
deliberately NOT constrained by team, because a player's team_id in our
`players` table reflects LAST SEASON and may be stale after summer
transfers. A confident name match here also corrects that team_id to
the current one, fixing the exact staleness gap flagged since the
first Hail Mary Score run - but DEBOUNCED (players.pending_team_id):
confirmed live that FanTeam's own payload can genuinely alternate which
club it reports for a given player between scrapes, so a new team only
gets committed (and logged) once it's been seen on two consecutive
imports, not acted on the instant it first disagrees. Anyone not found
(new signings, promoted sides) gets a new canonical player created.
Anyone with an existing FanTeam game_players row NOT in this live pull gets deactivated
(is_active = false) - relegated clubs (Burnley, West Ham, Wolves this
season), dropped players, etc. Found by testing the squad builder
against real relegation data rather than assumed - it initially left
stale relegated-team players pickable.

RUN:
    python3 import_fanteam_live.py
"""

import io
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
from name_matching import compact, surname_variants  # noqa: E402

# Real player names legitimately contain non-ASCII characters - Windows'
# console codepage can't print those directly.
sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding="utf-8", errors="replace")

SEASON = "2026/27"

# See the [cooldown] guard in import_players() - a second, independent
# check on top of the "confirmed twice in a row" debounce, for players
# whose live payload genuinely oscillates faster than that debounce alone
# can absorb.
TEAM_CHANGE_COOLDOWN = timedelta(hours=24)

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
            "select id, kickoff_at from fixtures where home_team_id = %s and away_team_id = %s and competition = 'soccer_epl' and season = %s",
            (home_id, away_id, SEASON),
        )
        row = cur.fetchone()
        if row:
            fixture_id = row[0]
            if row[1] != kickoff:
                cur.execute("update fixtures set kickoff_at = %s where id = %s", (kickoff, fixture_id))
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

    # For activity_log summaries ("moved from X to Y") - teams table is
    # tiny, cheap to load whole.
    cur.execute("select id, name from teams")
    team_name_by_id = {tid: name for tid, name in cur.fetchall()}

    # Most recent team_changed commit per player, for the cooldown guard
    # below - real cases found live (Boubacar Kamara, Abdoullah Ba, Johan
    # Manzambi) where FanTeam's payload satisfies the "same new team seen
    # twice in a row" debounce rule repeatedly within days, genuinely
    # oscillating rather than settling - a real transfer doesn't flip back
    # a few days later. Game-independent (activity_log isn't scoped to
    # one fantasy game) since a transfer is a real-world fact.
    cur.execute(
        "select (details->>'player_id')::bigint as player_id, max(created_at) as last_changed_at "
        "from activity_log where event_type = 'team_changed' group by (details->>'player_id')::bigint"
    )
    last_team_change_by_id: dict[int, datetime] = {row[0]: row[1] for row in cur.fetchall()}

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

        # Real surname match: live and candidate share at least one whole
        # hyphen-bounded surname component (see surname_variants() in
        # name_matching.py) - handles "E. Haaland" vs "Erling Haaland"
        # (different first-name formats, same surname) in both directions,
        # AND a canonical row stored with a compound surname ("Jamie
        # Bynoe-Gittens") matching FanTeam's live feed sending the
        # shortened form ("Jamie Gittens") - a real case, confirmed live,
        # that used to need its own explicit reverse-direction endswith
        # check. That raw endswith approach is exactly what let "M. Lewis-
        # Skelly" (real surname "Lewis-Skelly") spuriously match 4
        # unrelated players surnamed "Kelly" - confirmed live 2026-08-08 -
        # because "lewisskelly" ends in the letters "kelly" purely by
        # coincidence; matching on whole hyphen-bounded components instead
        # of raw character suffixes tells those apart. A bare mononym like
        # "Gabriel" shares no surname component with anything, so for that
        # case a separate rule accepts the candidate's full name simply
        # starting with the mononym - catches "Gabriel" matching stored
        # "Gabriel Magalhaes".
        #
        # surname_variants() can legitimately include "" for a placeholder
        # name like "Trialist 111" (real rows - lower-league clubs list
        # genuine unnamed trialists on their provisional squads, see EFL
        # Fantasy's own import) - "" is not a real surname, but
        # str.endswith("") is unconditionally True, so treating that as a
        # match used to make EVERY same-position player look "ambiguous"
        # against these rows - confirmed live 2026-08-07 for Dream Team's
        # own copy of this exact pattern (see import_dreamteam.py). A
        # surname variant shorter than this can never participate.
        MIN_SURNAME_KEY_LEN = 2
        live_variants = {v for v in surname_variants(live_full_name) if len(v) >= MIN_SURNAME_KEY_LEN}

        def _surname_matches(candidate_name: str) -> bool:
            candidate_variants = {v for v in surname_variants(candidate_name) if len(v) >= MIN_SURNAME_KEY_LEN}
            if live_variants & candidate_variants:
                return True
            if is_mononym and compact(candidate_name).startswith(live_compact):
                return True
            return False

        candidates = [(pid, name, team_id) for pid, name, team_id in by_position.get(live_position, []) if _surname_matches(name)]

        # Position-bucketing above is an optimisation, not an identity
        # rule - FanTeam does reclassify a player's listed position (real
        # cases found: Ethan Ampadu DEF->MID, Evann Guessand FWD->MID,
        # Lamare Bogarde DEF->MID, Mats Wieffer MID->DEF, all on the same
        # import run), and players.position is only ever set once at
        # creation, never updated. Without this fallback, a
        # reclassification silently produces a duplicate player+
        # game_player row instead of updating the existing one - the
        # zero-candidates case falls straight through to "insert new
        # player" below with no visibility at all. Only runs when the
        # position bucket found nothing, so the common case (position
        # unchanged) is untouched.
        if not candidates:
            candidates = [(pid, name, team_id) for pid, name, team_id in all_players if _surname_matches(name)]

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

        # A LONE candidate still needs this same first-initial check - the
        # surname-suffix rule above is a literal string test with no
        # first-name awareness, so two genuinely different real people who
        # share a surname (confirmed live: FanTeam really does list both a
        # "Boubacar Kamara" and an "Abu Kamara", different clubs, same
        # position) silently merge into one row the moment only one of
        # them has ever been imported - len(candidates) > 1 above never
        # triggers because there's only one existing DB row to begin with.
        # Real bug found this way: it flip-flopped Boubacar Kamara's team
        # between his two clubs on every import run. An exact full-name
        # match is exempted (deliberately not requiring the initial check)
        # since that's already an unambiguous identity match.
        #
        # A real nickname can share no first letter at all with the full
        # name it's short for ("Tino" for "Valentino") - confirmed live:
        # this guard silently rejected "Tino Livramento" against the
        # stored "Valentino Livramento" every run, recreating a duplicate
        # each time. Exempted the same way an exact match already is, but
        # only when the candidate's own first name actually CONTAINS the
        # live first name as a substring - "boubacar" doesn't contain
        # "abu", so the real Kamara-collision guard this exists for is
        # untouched; "valentino" does contain "tino".
        if len(candidates) == 1 and not is_mononym and compact(candidates[0][1]) != live_compact:
            candidate_first_name = candidates[0][1].split(" ", 1)[0].lower()
            live_first_name = live_full_name.split(" ", 1)[0].lower()
            is_nickname_of_candidate = live_first_name and live_first_name in candidate_first_name
            if candidates[0][1][0].lower() != live_full_name[0].lower() and not is_nickname_of_candidate:
                candidates = []

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
            if position_by_id.get(player_id) != live_position:
                # No debounce needed here, unlike team_id above - a
                # position reclassification isn't the kind of payload
                # noise that flip-flops between scrapes, it's a genuine
                # one-off FanTeam-side change. Keeping players.position
                # in sync is exactly what stops the next import from
                # hitting this same "position bucket" miss again.
                cur.execute("update players set position = %s where id = %s", (live_position, player_id))
                position_by_id[player_id] = live_position
            if canonical_team_id != live_team_id:
                # Debounced: confirmed live that FanTeam's own payload can
                # genuinely alternate which realTeamId it reports for a
                # given real player between scrapes (Boubacar Kamara,
                # Abdoullah Ba both flip-flopped between two real clubs on
                # every import - not a name-matching issue, each had
                # exactly one unambiguous DB candidate throughout). Only
                # commit team_id (and log the event) once the SAME new
                # team has been seen on two consecutive imports - a real
                # transfer persists into the next scrape by definition, a
                # one-off upstream blip doesn't.
                debounce_confirmed = pending_team_by_id.get(player_id) == live_team_id
                last_changed_at = last_team_change_by_id.get(player_id)
                # Real gap found in this same debounce: Abdoullah Ba and
                # Johan Manzambi both satisfied "same new team twice in a
                # row" repeatedly within a single day, genuinely
                # oscillating between two clubs rather than settling - a
                # real transfer doesn't flip back days later. This second
                # guard requires the cooldown to have elapsed since the
                # LAST commit too, not just two consecutive scrapes -
                # catches exactly the payload instability the debounce
                # alone didn't.
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
                        cur,
                        "team_changed",
                        f"{canonical_name} moved from {old_team_name} to {new_team_name}",
                        game_id=game_id,
                        details={"player_id": player_id, "old_team_id": canonical_team_id, "new_team_id": live_team_id},
                    )
                else:
                    cur.execute(
                        "update players set pending_team_id = %s, pending_team_seen_at = now() where id = %s",
                        (live_team_id, player_id),
                    )
            elif pending_team_by_id.get(player_id) is not None:
                # Live team now agrees with what's already stored - clear
                # a stale pending flag from an earlier blip that never
                # got confirmed on a second run.
                cur.execute("update players set pending_team_id = null, pending_team_seen_at = null where id = %s", (player_id,))
        else:
            cur.execute(
                "insert into players (full_name, team_id, position) values (%s, %s, %s) returning id",
                (live_full_name, live_team_id, live_position),
            )
            player_id = cur.fetchone()[0]
            created += 1

        external_id = str(pc["realPlayerId"])
        seen_external_ids.add(external_id)
        # A player can (rarely) end up with more than one game_players row
        # for the same game - e.g. right after merge_player_identities.py
        # consolidates a split identity, the canonical player briefly has
        # its own old (now-stale) row alongside the newly-repointed one
        # until this import naturally settles it. Ordering by "does this
        # row's external_id already match the live one" first, then
        # is_active, makes the choice deterministic instead of picking
        # whichever row Postgres happens to return first - confirmed live
        # this crashed with a real unique-constraint violation otherwise
        # (the stale row got its external_id blindly overwritten to a
        # value the OTHER row already owned).
        cur.execute(
            """
            select id from game_players where game_id = %s and player_id = %s
            order by (external_id = %s) desc, is_active desc, id desc
            limit 1
            """,
            (game_id, player_id, external_id),
        )
        row = cur.fetchone()
        # selectedRatio: FanTeam's own live ownership % (2026-08-23 user
        # request - "feed the ownership data in also for Dream Team and
        # FanTeam"), a string percentage already present in every
        # playerChoices entry - missing entirely for a player nobody's
        # picked yet, never treat that absence as a real 0.
        ownership_pct = float(pc["selectedRatio"]) if pc.get("selectedRatio") is not None else None
        if row:
            game_player_id = row[0]
            cur.execute(
                "update game_players set external_id = %s, position_code = %s, price = %s, is_active = true, "
                "ownership_pct = %s, updated_at = now() where id = %s",
                (external_id, live_position, pc["price"], ownership_pct, game_player_id),
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
                insert into game_players (game_id, player_id, external_id, position_code, price, is_active, ownership_pct)
                values (%s, %s, %s, %s, %s, true, %s)
                on conflict (game_id, external_id) do update
                    set player_id = excluded.player_id, position_code = excluded.position_code, price = excluded.price,
                        is_active = true, ownership_pct = excluded.ownership_pct, updated_at = now()
                returning id
                """,
                (game_id, player_id, external_id, live_position, pc["price"], ownership_pct),
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

        # Real production incident 2026-08-22: scraper_fanteam.py's own
        # players fetch failed (a transient HTTP 401 - confirmed live
        # minutes later the same endpoint was back to a normal 200,
        # exactly the class of blip already anticipated in that script's
        # own fetch_json docstring), so it never wrote this file at all.
        # run_step() in refresh_all.py doesn't stop the pipeline on one
        # step's failure, so this ran anyway straight into an unhandled
        # FileNotFoundError/pathlib traceback - a real crash, but one
        # that obscured the actual (upstream, transient) cause behind a
        # confusing low-level error. Fail the same way (still a real
        # failure - there's genuinely no fresh data to import), just
        # with a message that says what actually happened.
        players_path = ROOT / "fanteam_players_raw.json"
        if not players_path.exists():
            raise SystemExit(
                "fanteam_players_raw.json not found - scraper_fanteam.py's players fetch must have failed "
                "upstream (see that step's own log for why, e.g. a transient HTTP error). Nothing to import "
                "this run."
            )
        players_data = json.loads(players_path.read_text(encoding="utf-8"))
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
