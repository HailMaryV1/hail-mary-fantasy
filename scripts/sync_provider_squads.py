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

Player matching is name+price based (surname_key, the same technique -
and the same compound-surname fix - already proven correct elsewhere in
this codebase for FanTeam data; see import_fanteam_live.py's own
surname_key docstring for the Ta Bi/Manzambi bug this avoids repeating),
scoped to the target game's own player pool. A provider player that can't
be matched with EXACTLY one confident candidate is logged and skipped
rather than guessed - a wrong player silently entering a real squad would
be far worse than a gap.

RUN:
    python3 scripts/sync_provider_squads.py                  # every due link
    python3 scripts/sync_provider_squads.py --provider fanteam_scoutgg
"""
import argparse
import json
import os
import re
import sys
from pathlib import Path

import psycopg2
import psycopg2.extras

sys.path.insert(0, str(Path(__file__).resolve().parent))
import provider_fanteam_scoutgg as fanteam
import provider_secrets
from activity_log import log_event

ROOT = Path(__file__).resolve().parent.parent

# Sport/game classification of a FanTeam tournament_id is a one-time,
# human config decision, not something the API tells us - same
# established pattern as scraper_fanteam.py's own hardcoded TOURNAMENT_ID
# and scraper_fanteam_golf.py's tournament_id argument. Extend this
# mapping (not runtime-guessed) whenever a new real entry is confirmed.
FANTEAM_TOURNAMENT_GAME_SLUG = {
    "1131483": "fanteam",  # EPL Fantasy Season Game [Micro] - real, verified 2026-07-30
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


def compact(name):
    return re.sub(r"[^a-z]", "", name.lower())


def surname_key(full_name):
    parts = full_name.split(" ")
    return compact(" ".join(parts[1:])) if len(parts) > 1 else compact(full_name)


def match_player(cur, game_id, provider_name, price):
    """Exactly one confident game_player_id, or None (never a guess among
    several candidates). Matches on surname_key + price - price is real
    signal here (FanTeam's own current price, already stored on
    game_players by the regular player import), not just a tiebreaker."""
    key = surname_key(provider_name)
    cur.execute(
        """
        select gp.id, p.full_name, gp.price
        from game_players gp
        join players p on p.id = gp.player_id
        where gp.game_id = %s and gp.is_active = true
        """,
        (game_id,),
    )
    candidates = [r for r in cur.fetchall() if surname_key(r["full_name"]) == key]
    if len(candidates) == 1:
        return candidates[0]["id"]
    if len(candidates) > 1:
        price_matches = [c for c in candidates if c["price"] is not None and abs(float(c["price"]) - price) < 0.05]
        if len(price_matches) == 1:
            return price_matches[0]["id"]
    return None


def get_or_create_squad_link(cur, user_id, provider, game_slug, tournament_id, team_id, squad_name):
    """Idempotent: an existing link for this (provider, external_team_id)
    is always reused, never duplicated - the unique constraint in
    migration 0071 is the real backstop, this is just the friendly path
    that avoids hitting it."""
    cur.execute(
        "select id, squad_id from provider_squad_links where provider = %s and external_team_id = %s",
        (provider, team_id),
    )
    row = cur.fetchone()
    if row:
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
        insert into provider_squad_links (squad_id, provider, external_tournament_id, external_team_id)
        values (%s, %s, %s, %s)
        returning id
        """,
        (squad_id, provider, tournament_id, team_id),
    )
    link_id = cur.fetchone()["id"]
    return squad_id, link_id


def apply_squad(cur, squad_id, game_id, parsed_squad):
    """Writes the parsed provider squad into squads/squad_players, diffed
    against what's already there. Returns a list of human-readable change
    summary strings (empty on a genuinely unchanged re-sync)."""
    changes = []
    all_entries = [dict(p, is_starting=True) for p in parsed_squad["starting"]] + [
        dict(p, is_starting=False) for p in parsed_squad["bench"]
    ]

    resolved = []
    unmatched = []
    for idx, entry in enumerate(all_entries):
        gpid = match_player(cur, game_id, entry["name"], entry["price"])
        if gpid is None:
            unmatched.append(entry["name"])
            continue
        resolved.append((gpid, entry, idx))
    if unmatched:
        changes.append(f"Could not confidently match: {', '.join(unmatched)} - left out of the synced squad, needs a manual look.")

    cur.execute("select game_player_id, is_starting, bench_order from squad_players where squad_id = %s", (squad_id,))
    before = {r["game_player_id"]: r for r in cur.fetchall()}
    cur.execute("select captain_game_player_id, vice_captain_game_player_id from squads where id = %s", (squad_id,))
    before_squad = cur.fetchone()

    after_ids = {gpid for gpid, _, _ in resolved}
    removed_ids = set(before.keys()) - after_ids
    added_ids = after_ids - set(before.keys())

    if removed_ids:
        cur.execute("delete from squad_players where squad_id = %s and game_player_id = any(%s)", (squad_id, list(removed_ids)))
    for gpid, entry, idx in resolved:
        bench_order = None
        if not entry["is_starting"] and entry["position"] != "GK":
            bench_order = [e["is_starting"] for e in all_entries[:idx]].count(False) or 1
        cur.execute(
            """
            insert into squad_players (squad_id, game_player_id, is_starting, bench_order)
            values (%s, %s, %s, %s)
            on conflict (squad_id, game_player_id)
            do update set is_starting = excluded.is_starting, bench_order = excluded.bench_order
            """,
            (squad_id, gpid, entry["is_starting"], bench_order),
        )

    captain_gpid = next((gpid for gpid, e, _ in resolved if e["is_captain"]), None)
    vice_gpid = next((gpid for gpid, e, _ in resolved if e["is_vice_captain"]), None)
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


def sync_fanteam(cur, user_id, credential_row, requested_only=False):
    if requested_only:
        # Cheap path for the frequent (~5 min) scheduled check - a real
        # FanTeam login on every single tick, all day, every day, would
        # hammer their login endpoint for no reason on the ~99% of ticks
        # where nobody clicked "Sync Now". One indexed lookup answers
        # "is there anything to do" before paying for a real login.
        cur.execute(
            "select 1 from provider_squad_links where provider = 'fanteam_scoutgg' and sync_requested_at is not null limit 1"
        )
        if not cur.fetchone():
            print("  [skip] no sync_requested_at pending - not logging in.")
            return

    email = provider_secrets.decrypt(credential_row["encrypted_username"])
    password = provider_secrets.decrypt(credential_row["encrypted_password"])
    access_token, refresh_token, profile = fanteam.login(email, password)
    cur.execute(
        "update provider_credentials set last_refreshed_at = now(), last_refresh_error = null where id = %s",
        (credential_row["id"],),
    )

    teams = fanteam.list_my_teams(access_token)
    from playwright.sync_api import sync_playwright

    with sync_playwright() as p:
        for team in teams:
            tournament_id = team["tournament_id"]
            game_slug = FANTEAM_TOURNAMENT_GAME_SLUG.get(tournament_id)
            if not game_slug:
                print(f"  [skip] tournament {tournament_id} not in FANTEAM_TOURNAMENT_GAME_SLUG - add it once its sport is confirmed.")
                continue

            cur.execute("select id from fantasy_games where slug = %s", (game_slug,))
            game_id = cur.fetchone()["id"]
            squad_id, link_id = get_or_create_squad_link(
                cur, user_id, "fanteam_scoutgg", game_slug, tournament_id, team["fantasy_team_id"], f"FanTeam {game_slug}"
            )
            try:
                parsed = fanteam.fetch_squad(p, access_token, tournament_id, team["fantasy_team_id"])
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


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--provider", choices=["fanteam_scoutgg"], default=None)
    parser.add_argument(
        "--requested-only", action="store_true",
        help="Only act if a 'Sync Now' click is actually pending - for the frequent scheduled check (see .github/workflows/provider_sync_requested.yml). Never logs in otherwise.",
    )
    args = parser.parse_args()

    load_env()
    conn = psycopg2.connect(os.environ["DATABASE_URL"])
    conn.autocommit = False
    cur = conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor)

    providers = [args.provider] if args.provider else ["fanteam_scoutgg"]
    try:
        for provider in providers:
            cur.execute("select * from provider_credentials where provider = %s", (provider,))
            cred = cur.fetchone()
            if not cred:
                print(f"No stored credentials for {provider} - run scripts/bootstrap_provider_credentials.py first.")
                continue
            print(f"Syncing {provider} ...")
            if provider == "fanteam_scoutgg":
                sync_fanteam(cur, cred["user_id"], cred, requested_only=args.requested_only)
            conn.commit()
    except Exception:
        conn.rollback()
        raise
    finally:
        cur.close()
        conn.close()


if __name__ == "__main__":
    main()
