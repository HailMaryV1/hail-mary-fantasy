"""
poll_golf_live_scores.py
--------------------------
Live, in-tournament FanTeam Golf scoring - separate from
scraper_fanteam_golf.py/import_fanteam_golf.py (which pull the
PRE-tournament player pool/pricing via `?round=editable`, an endpoint
that returns 401 the instant picks lock and the tournament starts).

The live equivalent, confirmed by capturing FanTeam's own public
dashboard page's real network call against a genuinely live tournament:

    GET /tournaments/{tournament_id}/players?round={event_number}

`round` here is the literal gameweek/event number (e.g. 27), not the
string "editable" - unauthenticated, 200 OK, confirmed matching the
live score shown on fanteam.com's own page exactly. Each entry's
`points` field is this tournament's live score so far (distinct from
`totalPoints`, the golfer's all-time season total).

Matched back to golf_tournament_entries by (tournament_id,
external_player_id = realPlayerId) - a direct ID lookup already stored
from the original import, no name-matching involved (deliberately
avoids the whole bug class just fixed twice this session for football).

Meant to run every ~5 minutes via .github/workflows/golf_live_scores.yml
during an active tournament - but is itself defensive about that: if no
golf_tournaments row is currently in its live window
(registration_time <= now <= end_time), it prints and exits 0
immediately, so a wide-ish cron schedule stays cheap outside real play.

Score changes are logged through the existing activity_log table
(scripts/activity_log.py's log_event(), already used by 3 other
scripts) under a new event_type 'golf_score_changed' - a free audit
trail, no new table needed for that part.

Notifications: only sent for a changed golfer if they're actually
rostered in one of the current user's saved golf squads for the live
tournament (skips changes to golfers nobody has picked), collapsed to
one notification per real change even if a golfer appears in several of
a user's saved team variants. Sent via pywebpush to every active row in
push_subscriptions (migration 0054) - a 404/410 response means the
browser evicted that subscription, so it's deactivated rather than
retried forever.

RUN:
    python3 scripts/poll_golf_live_scores.py
"""

import json
import os
import sys
import time
import urllib.error
import urllib.request
from pathlib import Path

import psycopg2
import psycopg2.extras
from pywebpush import WebPushException, webpush

sys.path.insert(0, str(Path(__file__).resolve().parent))
from activity_log import log_event  # noqa: E402

ROOT = Path(__file__).resolve().parent.parent
BASE = "https://fanteam-game.api.scoutgg.net"


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


# The live-scoring variant of the players endpoint (?round=<gameweek>,
# unlike scraper_fanteam_golf.py's pre-tournament ?round=editable) 401s
# with {"error":"no_client"} unless this exact header is present -
# confirmed live by capturing FanTeam's own frontend's real request via
# the user's browser DevTools. "Bearer fanteam" is a fixed, non-secret
# constant baked into their public frontend bundle (not a per-user
# token, not tied to any login) - the same value every anonymous visitor's
# browser sends, safe to hardcode here.
LIVE_HEADERS = {
    "User-Agent": "Mozilla/5.0",
    "Accept": "application/json",
    "Authorization": "Bearer fanteam",
    "Origin": "https://www.fanteam.com",
    "Referer": "https://www.fanteam.com/",
}


def fetch_json(url, retries=3, backoff_seconds=5):
    req = urllib.request.Request(url, headers=LIVE_HEADERS)
    last_status = None
    for attempt in range(1, retries + 1):
        try:
            with urllib.request.urlopen(req, timeout=30) as resp:
                return resp.status, json.loads(resp.read())
        except urllib.error.HTTPError as e:
            last_status = e.code
        except urllib.error.URLError as e:
            print(f"  Network error on attempt {attempt}/{retries}: {e.reason}")
            last_status = None
        if attempt < retries:
            status_desc = f"HTTP {last_status}" if last_status is not None else "a network error"
            print(f"  Attempt {attempt}/{retries} got {status_desc} - retrying in {backoff_seconds}s ...")
            time.sleep(backoff_seconds)
    return last_status, None


def fetch_live_tournament(cur):
    """The one golf_tournaments row currently in its playing window, if
    any - registration_time is the real deadline (picks lock, scoring
    starts), end_time the tournament's final round finish."""
    cur.execute(
        """
        select id, fanteam_tournament_id, name, event_number
        from golf_tournaments
        where now() between registration_time and end_time
        order by start_time desc
        limit 1
        """
    )
    return cur.fetchone()


def send_push(cur, subscription, title, body, tag):
    try:
        webpush(
            subscription_info={
                "endpoint": subscription["endpoint"],
                "keys": {"p256dh": subscription["p256dh"], "auth": subscription["auth"]},
            },
            data=json.dumps({"title": title, "body": body, "tag": tag}),
            vapid_private_key=os.environ["VAPID_PRIVATE_KEY"],
            vapid_claims={"sub": os.environ["VAPID_SUBJECT"]},
        )
        return True
    except WebPushException as e:
        status = e.response.status_code if e.response is not None else None
        if status in (404, 410):
            # Browser evicted this subscription (uninstalled, cleared
            # storage, ...) - stop retrying it every cycle.
            cur.execute("update push_subscriptions set is_active = false where id = %s", (subscription["id"],))
        else:
            print(f"  push failed for subscription {subscription['id']}: {e}")
        return False


def main():
    load_env()
    conn = psycopg2.connect(os.environ["DATABASE_URL"])
    conn.autocommit = False
    cur = conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor)

    try:
        tournament = fetch_live_tournament(cur)
        if not tournament:
            print("No golf tournament is currently in its live window - nothing to poll.")
            return

        print(f"Polling live scores for {tournament['name']!r} (gameweek {tournament['event_number']}) ...")
        status, data = fetch_json(
            f"{BASE}/tournaments/{tournament['fanteam_tournament_id']}/players?round={tournament['event_number']}"
        )
        if status != 200:
            raise SystemExit(f"Live players request failed: HTTP {status}")

        changed = []  # (game_player_id, golfer_name, old_points, new_points)
        for pc in data.get("playerChoices", []):
            external_player_id = str(pc["realPlayerId"])
            new_points = pc.get("points")
            if new_points is None:
                continue

            cur.execute(
                """
                select gte.id, gte.game_player_id, gte.raw, g.full_name
                from golf_tournament_entries gte
                left join game_players gp on gp.id = gte.game_player_id
                left join golfers g on g.id = gp.golfer_id
                where gte.tournament_id = %s and gte.external_player_id = %s
                """,
                (tournament["id"], external_player_id),
            )
            entry = cur.fetchone()
            if not entry or not entry["game_player_id"]:
                continue  # golfer not in our imported pool (or never matched to a game_player)

            old_raw = entry["raw"] or {}
            if isinstance(old_raw, str):
                old_raw = json.loads(old_raw)
            old_points = old_raw.get("points")

            cur.execute("update golf_tournament_entries set raw = %s, updated_at = now() where id = %s", (json.dumps(pc), entry["id"]))

            if old_points is not None and float(old_points) != float(new_points):
                delta = float(new_points) - float(old_points)
                golfer_name = entry["full_name"] or "Unknown golfer"
                changed.append((entry["game_player_id"], golfer_name, float(old_points), float(new_points)))
                log_event(
                    cur,
                    "golf_score_changed",
                    f"{golfer_name} {delta:+.1f} pts ({old_points:.1f} -> {new_points:.1f}) - {tournament['name']}",
                    game_player_id=entry["game_player_id"],
                    details={"tournament_id": tournament["id"], "old_points": old_points, "new_points": new_points, "delta": delta},
                )

        # Commit the score updates + activity_log entries now, before any
        # notification work - a live score change is real, valuable data
        # the moment it's detected, independent of whether notifying
        # about it succeeds. Confirmed live: an uncaught exception in the
        # notify path (a missing VAPID secret, a network hiccup) used to
        # roll back this entire transaction, silently discarding real
        # score updates run after run - this is what actually happened
        # while the VAPID secrets hadn't been added to GitHub yet.
        conn.commit()

        if not changed:
            print("No score changes this poll.")
            return

        print(f"{len(changed)} golfer score change(s) detected - checking who rostered them ...")

        # Notifications are best-effort from here - any failure in this
        # section is caught and logged, never allowed to undo the score
        # data already committed above.
        try:
            # For each changed golfer, which users have them in a saved
            # squad for THIS live tournament - collapsed so a golfer
            # shared across several of one user's saved team variants
            # only notifies once.
            changed_game_player_ids = [c[0] for c in changed]
            cur.execute(
                """
                select distinct s.user_id, sp.game_player_id
                from squads s
                join squad_players sp on sp.squad_id = s.id
                where s.golf_tournament_id = %s and sp.game_player_id = any(%s)
                """,
                (tournament["id"], changed_game_player_ids),
            )
            rostered_by_user = {}
            for row in cur.fetchall():
                rostered_by_user.setdefault(row["user_id"], set()).add(row["game_player_id"])

            if not rostered_by_user:
                print("None of the changed golfers are in any saved team - no notifications to send.")
                return

            changes_by_game_player_id = {c[0]: c for c in changed}
            cur.execute("select id, user_id, endpoint, p256dh, auth from push_subscriptions where is_active")
            subscriptions_by_user = {}
            for row in cur.fetchall():
                subscriptions_by_user.setdefault(row["user_id"], []).append(row)

            sent = 0
            for user_id, game_player_ids in rostered_by_user.items():
                for subscription in subscriptions_by_user.get(user_id, []):
                    for game_player_id in game_player_ids:
                        _, golfer_name, old_points, new_points = changes_by_game_player_id[game_player_id]
                        delta = new_points - old_points
                        ok = send_push(
                            cur,
                            subscription,
                            title=f"{golfer_name} {delta:+.1f} pts",
                            body=f"{old_points:.1f} -> {new_points:.1f} - {tournament['name']}",
                            tag=f"golf-{tournament['id']}-{game_player_id}",
                        )
                        if ok:
                            sent += 1

            print(f"Sent {sent} push notification(s).")
            conn.commit()  # subscription deactivations from send_push, if any
        except Exception as e:
            conn.rollback()
            print(f"Notification step failed (score data above is already saved): {e}")
    except Exception:
        conn.rollback()
        raise
    finally:
        cur.close()
        conn.close()


if __name__ == "__main__":
    main()
