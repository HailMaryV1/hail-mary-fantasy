"""
sync_provider_squads.py
------------------------
Auto Import My Squad - the shared orchestrator every provider plugs into
(migration 0071's provider_credentials/provider_squad_links). One run of
this script:

  1. Discovers any of the user's real entries on a provider not yet
     linked to a Hail Mary squad, and creates that link (never touching
     an existing one - see _get_or_create_squad's on-conflict handling,
     the actual duplicate-prevention mechanism).
  2. Re-fetches the live squad for every linked, sync-enabled entry.
  3. Diffs it against Hail Mary's current squad_players/captain/vice-
     captain, writes only what changed, and logs a real, specific
     activity_log entry for each detected change (not just "synced").
  4. Records success/failure and a human-readable change summary on
     provider_squad_links, and clears sync_requested_at so the frontend's
     "Sync Now" button (which only ever sets that column - see migration
     0071's RLS policy comment) knows its request was picked up.

Every provider adapter resolves its own real squad data down to a list
of real game_player_ids, then hands off to the one shared write/diff
function, apply_resolved_squad - that's the actual "one shared squad-
sync architecture" boundary (not five disconnected per-provider
writers). How a provider gets to a game_player_id varies: FanTeam's
squad page is DOM-only and only exposes display names, so apply_squad
resolves via name+price matching (surname_key, the same technique - and
the same compound-surname fix - already proven correct elsewhere in
this codebase; see import_fanteam_live.py's own surname_key docstring
for the Ta Bi/Manzambi bug this avoids repeating), scoped to the target
game's own player pool - a provider player that can't be matched with
EXACTLY one confident candidate is logged and skipped rather than
guessed, a wrong player silently entering a real squad being far worse
than a gap. Cloud FF's real API returns real numeric PlayerIDs directly
(sync_cloudff), which already equal game_players.external_id from
import_cloudff.py - no name-matching needed at all.

RUN:
    python3 scripts/sync_provider_squads.py                  # every due link
    python3 scripts/sync_provider_squads.py --provider fanteam_scoutgg
    python3 scripts/sync_provider_squads.py --provider cloudff
"""
import argparse
import json
import os
import sys
from datetime import datetime, timedelta, timezone
from pathlib import Path

import psycopg2
import psycopg2.extras

sys.path.insert(0, str(Path(__file__).resolve().parent))
import provider_cloudff as cloudff
import provider_fanteam_scoutgg as fanteam
import provider_secrets
from activity_log import log_event
from name_matching import compact, surname_key

ROOT = Path(__file__).resolve().parent.parent

# Real classification now comes from FanTeam's own tournament API (see
# provider_fanteam_scoutgg.fetch_tournament_meta - gameType/name read
# straight off the response, confirmed live) - a NEW EPL contest no
# longer needs a manual code change to be picked up. This dict is kept
# only as an EXPLICIT OVERRIDE / safety fallback for a tournament_id
# fetch_tournament_meta can't classify (request failure, or a gameType
# value not yet in GAME_TYPE_TO_SPORT) - not the primary gate anymore.
FANTEAM_TOURNAMENT_GAME_SLUG = {
    "1131483": "fanteam",  # EPL Fantasy Season Game [Micro] - real, verified 2026-07-30
}

# Which Hail Mary game a classified sport lands a synced squad in. Only
# football is wired to an active squad-sync target today - a
# reliably-classified Golf/NFL competition still gets its
# provider_competitions row (honest bookkeeping, and sets up their own
# future "My Teams" pages for free) but no squad, until this page's
# equivalents for those sports exist.
SPORT_TO_GAME_SLUG = {
    "football": "fanteam",
}

SEASON = "2026/27"

# Cloud FF is a single ongoing season game, not tournament-based like
# FanTeam - there's exactly one real team per account, so this constant
# stands in for provider_squad_links.external_tournament_id (NOT NULL)
# where FanTeam would use a real tournament_id.
CLOUDFF_SEASON_TOKEN = "season"


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


# FanTeam's own position vocabulary, both the starting-XI full-word form
# and the bench short-code form ("FOR" - not "FWD", FanTeam's own naming
# - see provider_fanteam_scoutgg.py's BENCH_POSITION_CODES), mapped to
# this project's DB position codes.
POSITION_CODE = {
    "Goalkeeper": "GK", "Defender": "DEF", "Midfielder": "MID", "Forward": "FWD",
    "GK": "GK", "DEF": "DEF", "MID": "MID", "FOR": "FWD",
}


def match_player(cur, game_id, provider_name, price, position=None):
    """Exactly one confident game_player_id, or None (never a guess among
    several candidates). Primary match is surname_key + price - price is
    real signal here (FanTeam's own current price, already stored on
    game_players by the regular player import), not just a tiebreaker.
    Falls back to a given-name + price + position match for players
    FanTeam displays by first name only - confirmed live: DEF "Gabriel"
    (real entry: Gabriel Magalhaes, 6.5M, DEF) never has his surname
    rendered anywhere on FanTeam's squad-edit page, unlike every other
    real player observed. Price alone doesn't disambiguate him from the
    DB's other 6.5M "Gabriel" (Martinelli, MID) - position does."""
    cur.execute(
        """
        select gp.id, p.full_name, gp.price, p.position
        from game_players gp
        join players p on p.id = gp.player_id
        where gp.game_id = %s and gp.is_active = true
        """,
        (game_id,),
    )
    pool = cur.fetchall()

    key = surname_key(provider_name)
    candidates = [r for r in pool if surname_key(r["full_name"]) == key]
    if len(candidates) == 1:
        return candidates[0]["id"]
    if len(candidates) > 1:
        price_matches = [c for c in candidates if c["price"] is not None and abs(float(c["price"]) - price) < 0.05]
        if len(price_matches) == 1:
            return price_matches[0]["id"]
        return None

    given_key = compact(provider_name)
    given_name_matches = [
        r for r in pool
        if compact(r["full_name"].split(" ")[0]) == given_key
        and r["price"] is not None and abs(float(r["price"]) - price) < 0.05
        and (position is None or r["position"] == position)
    ]
    if len(given_name_matches) == 1:
        return given_name_matches[0]["id"]
    return None


def get_or_create_competition(cur, provider, external_competition_id, name, sport, status):
    """Upserts on (provider, external_competition_id) - a competition is
    shared across every squad entered into it (e.g. several separate
    teams in the same weekly contest), so this must never
    duplicate-create one per squad. Always bumps last_seen_at/updated_at
    on every call so a later cleanup pass can tell a competition that's
    stopped being discovered (most likely moved to Ended, which sync
    never visits) from one still genuinely active. Returns the
    competition's id."""
    cur.execute(
        """
        insert into provider_competitions
            (provider, external_competition_id, competition_name, sport, season, status, last_seen_at, updated_at)
        values (%s, %s, %s, %s, %s, %s, now(), now())
        on conflict (provider, external_competition_id) do update
        set competition_name = excluded.competition_name,
            sport = excluded.sport,
            season = excluded.season,
            status = excluded.status,
            last_seen_at = now(),
            updated_at = now()
        returning id
        """,
        (provider, external_competition_id, name, sport, SEASON, status),
    )
    return cur.fetchone()["id"]


def get_or_create_squad_link(cur, user_id, provider, game_slug, tournament_id, team_id, squad_name, competition_id=None):
    """Idempotent: an existing link for this (provider, external_team_id)
    is always reused, never duplicated - the unique constraint in
    migration 0071 is the real backstop, this is just the friendly path
    that avoids hitting it. `competition_id` is refreshed on every call
    (cheap, idempotent) rather than only set-once, so a link created
    before classification succeeded (e.g. via the explicit-override
    fallback, with no competition row yet) picks one up automatically
    once its tournament classifies cleanly on a later sync."""
    cur.execute(
        "select id, squad_id from provider_squad_links where provider = %s and external_team_id = %s",
        (provider, team_id),
    )
    row = cur.fetchone()
    if row:
        if competition_id is not None:
            cur.execute(
                "update provider_squad_links set competition_id = %s, updated_at = now() where id = %s",
                (competition_id, row["id"]),
            )
        return row["squad_id"], row["id"]

    cur.execute("select id from fantasy_games where slug = %s", (game_slug,))
    game_row = cur.fetchone()
    if not game_row:
        raise RuntimeError(f"No fantasy_games row for slug={game_slug!r}")
    game_id = game_row["id"]

    cur.execute(
        "insert into squads (user_id, game_id, name) values (%s, %s, %s) returning id",
        (user_id, game_id, squad_name),
    )
    squad_id = cur.fetchone()["id"]
    cur.execute(
        """
        insert into provider_squad_links (squad_id, provider, external_tournament_id, external_team_id, competition_id)
        values (%s, %s, %s, %s, %s)
        returning id
        """,
        (squad_id, provider, tournament_id, team_id, competition_id),
    )
    link_id = cur.fetchone()["id"]
    return squad_id, link_id


def apply_resolved_squad(cur, squad_id, resolved):
    """Writes an ALREADY-RESOLVED squad into squads/squad_players, diffed
    against what's already there - the provider-agnostic half of squad
    sync. `resolved` is a list of dicts: {"game_player_id", "is_starting",
    "bench_order", "is_captain", "is_vice_captain"}. Every provider
    adapter funnels into this same function once it has real
    game_player_ids in hand (FanTeam via apply_squad's name-matching
    below; Cloud FF directly, since its real PlayerIDs already equal
    game_players.external_id - see sync_cloudff) - this is the "one
    shared squad-sync architecture" boundary, not five disconnected
    per-provider writers. Returns a list of human-readable change summary
    strings (empty on a genuinely unchanged re-sync)."""
    changes = []

    cur.execute("select game_player_id, is_starting, bench_order from squad_players where squad_id = %s", (squad_id,))
    before = {r["game_player_id"]: r for r in cur.fetchall()}
    cur.execute("select captain_game_player_id, vice_captain_game_player_id from squads where id = %s", (squad_id,))
    before_squad = cur.fetchone()

    after_ids = {e["game_player_id"] for e in resolved}
    removed_ids = set(before.keys()) - after_ids
    added_ids = after_ids - set(before.keys())

    if removed_ids:
        cur.execute("delete from squad_players where squad_id = %s and game_player_id = any(%s)", (squad_id, list(removed_ids)))
    for e in resolved:
        cur.execute(
            """
            insert into squad_players (squad_id, game_player_id, is_starting, bench_order)
            values (%s, %s, %s, %s)
            on conflict (squad_id, game_player_id)
            do update set is_starting = excluded.is_starting, bench_order = excluded.bench_order
            """,
            (squad_id, e["game_player_id"], e["is_starting"], e["bench_order"]),
        )

    captain_gpid = next((e["game_player_id"] for e in resolved if e["is_captain"]), None)
    vice_gpid = next((e["game_player_id"] for e in resolved if e["is_vice_captain"]), None)
    cur.execute(
        "update squads set captain_game_player_id = %s, vice_captain_game_player_id = %s, updated_at = now() where id = %s",
        (captain_gpid, vice_gpid, squad_id),
    )

    if added_ids:
        cur.execute("select full_name from players p join game_players gp on gp.player_id = p.id where gp.id = any(%s)", (list(added_ids),))
        changes.append("Added: " + ", ".join(r["full_name"] for r in cur.fetchall()))
    if removed_ids:
        cur.execute("select full_name from players p join game_players gp on gp.player_id = p.id where gp.id = any(%s)", (list(removed_ids),))
        changes.append("Removed: " + ", ".join(r["full_name"] for r in cur.fetchall()))
    if before_squad and before_squad["captain_game_player_id"] != captain_gpid:
        changes.append("Captain changed")
    if before_squad and before_squad["vice_captain_game_player_id"] != vice_gpid:
        changes.append("Vice-captain changed")

    return changes


def apply_squad(cur, squad_id, game_id, parsed_squad):
    """FanTeam-specific: resolves the DOM-parsed squad (name/price/
    position per entry) to real game_player_ids via match_player, then
    hands off to apply_resolved_squad. Returns the same change-summary
    list, with an extra entry up front for anything that couldn't be
    confidently matched."""
    all_entries = [dict(p, is_starting=True) for p in parsed_squad["starting"]] + [
        dict(p, is_starting=False) for p in parsed_squad["bench"]
    ]

    resolved = []
    unmatched = []
    for idx, entry in enumerate(all_entries):
        gpid = match_player(cur, game_id, entry["name"], entry["price"], POSITION_CODE.get(entry["position"]))
        if gpid is None:
            unmatched.append(entry["name"])
            continue
        bench_order = None
        if not entry["is_starting"] and entry["position"] != "GK":
            bench_order = [e["is_starting"] for e in all_entries[:idx]].count(False) or 1
        resolved.append({
            "game_player_id": gpid, "is_starting": entry["is_starting"], "bench_order": bench_order,
            "is_captain": entry["is_captain"], "is_vice_captain": entry["is_vice_captain"],
        })

    changes = apply_resolved_squad(cur, squad_id, resolved)
    if unmatched:
        changes.insert(0, f"Could not confidently match: {', '.join(unmatched)} - left out of the synced squad, needs a manual look.")
    return changes


def sync_fanteam(cur, user_id, credential_row, requested_only=False):
    if requested_only:
        # Cheap path for the frequent (~5 min) scheduled check - avoids
        # even the cached-token branch below on the ~99% of ticks where
        # nobody clicked "Sync Now". One indexed lookup answers "is there
        # anything to do" first.
        cur.execute(
            "select 1 from provider_squad_links where provider = 'fanteam_scoutgg' and sync_requested_at is not null limit 1"
        )
        if not cur.fetchone():
            print("  [skip] no sync_requested_at pending - not logging in.")
            return

    # FanTeam's login endpoint started rejecting this script's own scripted
    # login live on 2026-08-03 (HTTP 451 auth.wrong_domain) - confirmed via
    # a real browser's DevTools capture that FanTeam's login page runs
    # Google reCAPTCHA, which a plain scripted request can never satisfy.
    # Deliberately NOT attempting fanteam.login() from here anymore - doing
    # so repeatedly, automatically, against a CAPTCHA-protected endpoint is
    # exactly the kind of traffic that control exists to filter, and every
    # attempt would just fail anyway. Instead this only ever reuses a
    # token the account owner supplied themselves after a real, human
    # login (see frontend/src/app/api/fanteam-token/route.ts and
    # /games/fanteam/sync-setup's bookmarklet) - the token itself is
    # exactly what a real logged-in browser already holds, this just
    # relays it rather than trying to obtain one automatically.
    expires_at = credential_row["access_token_expires_at"]
    if not credential_row["encrypted_access_token"] or not expires_at or expires_at <= datetime.now(timezone.utc):
        print("  [skip] no valid FanTeam token on file (bookmarklet not run recently, or it expired) - not syncing.")
        return
    access_token = provider_secrets.decrypt(credential_row["encrypted_access_token"])

    from playwright.sync_api import sync_playwright

    with sync_playwright() as p:
        browser, page = fanteam.open_authenticated_page(p, access_token)
        try:
            teams = fanteam.discover_my_teams(page)
        except Exception as e:
            browser.close()
            print(f"  [error] couldn't discover FanTeam entries: {e}")
            log_event(cur, "provider_sync_failed", f"FanTeam entry discovery failed: {e}")
            return

        try:
            for team in teams:
                tournament_id = team["tournament_id"]
                status = team["status"]

                name, sport = fanteam.fetch_tournament_meta(tournament_id)
                competition_id = None
                if name and sport:
                    competition_id = get_or_create_competition(cur, "fanteam_scoutgg", tournament_id, name, sport, status)
                    game_slug = SPORT_TO_GAME_SLUG.get(sport)
                    if not game_slug:
                        print(f"  [skip] tournament {tournament_id} ({name!r}): sport={sport!r} - not Football, no squad created on this page.")
                        continue
                else:
                    # Real classification failed (request error, or a
                    # gameType not yet in GAME_TYPE_TO_SPORT) - fall back
                    # to the explicit override. No competition row gets
                    # written here (name/sport genuinely aren't known
                    # reliably) - the squad link's competition_id stays
                    # null until a later sync classifies it cleanly.
                    game_slug = FANTEAM_TOURNAMENT_GAME_SLUG.get(tournament_id)
                    if not game_slug:
                        print(f"  [skip] tournament {tournament_id}: provider classification failed and no override - not syncing.")
                        continue
                    print(f"  [warn] tournament {tournament_id}: provider classification failed - using explicit override -> {game_slug}")

                cur.execute("select id from fantasy_games where slug = %s", (game_slug,))
                game_id = cur.fetchone()["id"]
                # get_or_create_squad_link needs SOME name at the moment
                # of first creation, before fetch_squad below has had a
                # chance to learn the real one (fetch_squad needs the
                # squad_id link to already exist to write into) - this
                # deterministic placeholder is FanTeam's OWN real display
                # convention for an entry with no private name set
                # (confirmed live via this account's real profile -
                # username "ciccio12" - matching the "ciccio12 #51333"
                # example documented in provider_fanteam_scoutgg.py), not
                # an invented label. Upgraded to the real private name
                # below the moment fetch_squad finds one.
                default_name = f"{profile.get('username') or username} #{team['fantasy_team_id']}"
                squad_id, link_id = get_or_create_squad_link(
                    cur, user_id, "fanteam_scoutgg", game_slug, tournament_id, team["fantasy_team_id"], default_name,
                    competition_id=competition_id,
                )
                try:
                    parsed = fanteam.fetch_squad(page, tournament_id, team["fantasy_team_id"])
                    # FanTeam's own "Edit private name" field (confirmed
                    # live via network capture - GET fantasy_teams/{id}
                    # ?round=editable's real fantasyTeam.privateName,
                    # never scraped from the DOM) is the real name to
                    # prefer. Only overwrites while the stored name still
                    # matches exactly what THIS run would have created it
                    # with by default - never touches a name the user
                    # deliberately changed inside Hail Mary itself.
                    private_name = parsed.get("private_name")
                    if private_name:
                        cur.execute(
                            "update squads set name = %s, updated_at = now() where id = %s and name = %s",
                            (private_name, squad_id, default_name),
                        )
                    changes = apply_squad(cur, squad_id, game_id, parsed)
                    summary = "; ".join(changes) if changes else "No changes detected"
                    cur.execute(
                        """
                        update provider_squad_links
                        set last_synced_at = now(), last_sync_status = 'ok', last_sync_error = null,
                            last_change_summary = %s, sync_requested_at = null, updated_at = now()
                        where id = %s
                        """,
                        (summary, link_id),
                    )
                    log_event(
                        cur, "provider_squad_synced", f"FanTeam squad synced ({game_slug}): {summary}",
                        game_id=game_id, details={"provider": "fanteam_scoutgg", "tournament_id": tournament_id, "changes": changes},
                    )
                    print(f"  [ok] {game_slug} team {team['fantasy_team_id']}: {summary}")
                except Exception as e:
                    cur.execute(
                        """
                        update provider_squad_links
                        set last_sync_status = 'error', last_sync_error = %s, sync_requested_at = null, updated_at = now()
                        where id = %s
                        """,
                        (str(e), link_id),
                    )
                    log_event(cur, "provider_sync_failed", f"FanTeam sync failed ({game_slug}): {e}", game_id=game_id)
                    print(f"  [error] {game_slug} team {team['fantasy_team_id']}: {e}")
        finally:
            browser.close()


def get_current_gameweek(cur, game_id):
    """The nearest gameweek that hasn't kicked off yet, from this game's
    own real fixture/gameweek mapping (already imported) - matches the
    real app's own "curgw" usage (confirmed live: 1, pre-season). Falls
    back to the latest known gameweek if every fixture has already kicked
    off, rather than crashing."""
    cur.execute(
        """
        select min(gfg.gameweek) as gw from game_fixture_gameweeks gfg
        join fixtures f on f.id = gfg.fixture_id
        where gfg.game_id = %s and f.kickoff_at > now()
        """,
        (game_id,),
    )
    row = cur.fetchone()
    if row and row["gw"] is not None:
        return row["gw"]
    cur.execute("select max(gameweek) as gw from game_fixture_gameweeks where game_id = %s", (game_id,))
    row = cur.fetchone()
    return row["gw"] if row and row["gw"] is not None else 1


def sync_cloudff(cur, user_id, credential_row, requested_only=False):
    if requested_only:
        cur.execute(
            "select 1 from provider_squad_links where provider = 'cloudff' and sync_requested_at is not null limit 1"
        )
        if not cur.fetchone():
            print("  [skip] no sync_requested_at pending - not logging in.")
            return

    game_slug = "cloudff"
    cur.execute("select id from fantasy_games where slug = %s", (game_slug,))
    game_id = cur.fetchone()["id"]

    # Reuse the stored access token while it's still valid - confirmed
    # live that Cloud FF's token lasts a full 14 days (see
    # provider_cloudff.py's module docstring), unlike FanTeam's ~3h token
    # which forces a fresh login on every single run.
    access_token = None
    team_id = None
    expires_at = credential_row["access_token_expires_at"]
    if credential_row["encrypted_access_token"] and expires_at and expires_at > datetime.now(timezone.utc) + timedelta(hours=1):
        access_token = provider_secrets.decrypt(credential_row["encrypted_access_token"])
        cur.execute(
            """
            select psl.external_team_id from provider_squad_links psl
            join squads s on s.id = psl.squad_id
            where psl.provider = 'cloudff' and s.user_id = %s
            limit 1
            """,
            (user_id,),
        )
        row = cur.fetchone()
        team_id = row["external_team_id"] if row else None

    if access_token is None or team_id is None:
        # No usable cached token/team_id (first run, expired token, or a
        # cached token with no known link yet) - a real login is the only
        # way to learn team_id at all, since Cloud FF's own token IS the
        # "which team do I have" answer (see provider_cloudff.py).
        email = provider_secrets.decrypt(credential_row["encrypted_username"])
        password = provider_secrets.decrypt(credential_row["encrypted_password"])
        access_token, claims = cloudff.login(email, password)
        expires_at = datetime.fromtimestamp(claims["exp"], tz=timezone.utc)
        team_id = str(claims["team_id"])
        cur.execute(
            """
            update provider_credentials
            set encrypted_access_token = %s, access_token_expires_at = %s,
                last_refreshed_at = now(), last_refresh_error = null
            where id = %s
            """,
            (provider_secrets.encrypt(access_token), expires_at, credential_row["id"]),
        )

    squad_id, link_id = get_or_create_squad_link(
        cur, user_id, "cloudff", game_slug, CLOUDFF_SEASON_TOKEN, team_id, "Cloud Fantasy Football"
    )

    try:
        current_gameweek = get_current_gameweek(cur, game_id)
        raw_squad = cloudff.fetch_squad(access_token, team_id, current_gameweek)

        cur.execute("select external_id, id from game_players where game_id = %s", (game_id,))
        gpid_by_external = {r["external_id"]: r["id"] for r in cur.fetchall()}

        resolved, unmatched_ids = [], []
        for position, player_ids in raw_squad.items():
            for pid in player_ids:
                gpid = gpid_by_external.get(str(pid))
                if gpid is None:
                    unmatched_ids.append(pid)
                    continue
                # Cloud FF's real API has no bench/captain concept at all
                # (confirmed live against the full response - see
                # provider_cloudff.py's module docstring) - every player
                # counts as starting, and the position breakdown itself
                # already is the formation.
                resolved.append({
                    "game_player_id": gpid, "is_starting": True, "bench_order": None,
                    "is_captain": False, "is_vice_captain": False,
                })

        changes = apply_resolved_squad(cur, squad_id, resolved)
        if unmatched_ids:
            changes.insert(0, f"Could not match Cloud FF PlayerIDs to a Hail Mary player: {unmatched_ids} - run import_cloudff.py again.")
        summary = "; ".join(changes) if changes else "No changes detected"

        cur.execute(
            """
            update provider_squad_links
            set last_synced_at = now(), last_sync_status = 'ok', last_sync_error = null,
                last_change_summary = %s, sync_requested_at = null, updated_at = now()
            where id = %s
            """,
            (summary, link_id),
        )
        log_event(
            cur, "provider_squad_synced", f"Cloud FF squad synced: {summary}",
            game_id=game_id, details={"provider": "cloudff", "team_id": team_id, "changes": changes},
        )
        print(f"  [ok] cloudff team {team_id}: {summary}")
    except Exception as e:
        cur.execute(
            """
            update provider_squad_links
            set last_sync_status = 'error', last_sync_error = %s, sync_requested_at = null, updated_at = now()
            where id = %s
            """,
            (str(e), link_id),
        )
        log_event(cur, "provider_sync_failed", f"Cloud FF sync failed: {e}", game_id=game_id)
        print(f"  [error] cloudff team {team_id}: {e}")


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--provider", choices=["fanteam_scoutgg", "cloudff"], default=None)
    parser.add_argument(
        "--requested-only", action="store_true",
        help="Only act if a 'Sync Now' click is actually pending - for the frequent scheduled check (see .github/workflows/provider_sync_requested.yml). Never logs in otherwise.",
    )
    args = parser.parse_args()

    load_env()
    conn = psycopg2.connect(os.environ["DATABASE_URL"])
    conn.autocommit = False
    cur = conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor)

    providers = [args.provider] if args.provider else ["fanteam_scoutgg", "cloudff"]
    # Each provider gets its own try/except - a real bug in one provider's
    # sync (or, historically, an uncaught auth failure - see sync_fanteam's
    # 2026-08-03 incident where FanTeam's blocked login took Cloud FF down
    # with it every run, purely because they shared one exception handler)
    # must never stop the other provider from being attempted. commit/
    # rollback is per-provider too, so one failure can't undo a different
    # provider's already-successful writes earlier in the same run.
    failures = []
    try:
        for provider in providers:
            cur.execute("select * from provider_credentials where provider = %s", (provider,))
            cred = cur.fetchone()
            if not cred:
                print(f"No stored credentials for {provider} - run scripts/bootstrap_provider_credentials.py first.")
                continue
            print(f"Syncing {provider} ...")
            try:
                if provider == "fanteam_scoutgg":
                    sync_fanteam(cur, cred["user_id"], cred, requested_only=args.requested_only)
                elif provider == "cloudff":
                    sync_cloudff(cur, cred["user_id"], cred, requested_only=args.requested_only)
                conn.commit()
            except Exception as e:
                conn.rollback()
                print(f"  [error] {provider} sync crashed: {e}")
                failures.append(provider)
    finally:
        cur.close()
        conn.close()

    if failures:
        raise SystemExit(f"Sync failed for: {', '.join(failures)} (see logs above) - other providers still ran normally.")


if __name__ == "__main__":
    main()
