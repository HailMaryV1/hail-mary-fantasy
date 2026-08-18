"""
detect_odds_swings.py
----------------------
Real user request 2026-08-18: "monitor large changes in bookies odds -
something that could alert us that they know something we don't maybe
with regards to lineups." A sudden shortening/lengthening in a player's
own market (not the fixture's overall win probability - see the reasoning
below) can reflect real inside knowledge about a lineup before it's
public - e.g. a striker's anytime-goalscorer price shortening a lot right
after a teammate is quietly ruled out in training.

Reads bookmaker_player_probability_history (migration 0120) - the
append-only log written alongside (not instead of) every REAL market
observation in import_sportmonks_player_props.py's populate_hub(). Only
REAL rows are logged, never ESTIMATED ones (is_estimated=true rows are a
scaled fixture-strength fallback, not a real market reaction - a change
there just means a fixture's own win probability moved, a different,
less interesting signal for "did they find out something about a
LINEUP").

Compares the two most recent observations per (player_id, fixture_id,
market) via a single windowed query, flags any pair whose absolute swing
clears that market's threshold (see SWING_THRESHOLDS below - a first-cut
starting point, not yet calibrated against real swing history, since none
existed before this script), and pushes a notification to every active
push_subscriptions row (real user choice: broadcast to anyone watching,
not scoped to who owns the player - a breakout signal on someone you
don't own yet is exactly the useful case). Marks the swing's row as
alerted immediately after detecting it (before attempting to send), same
"commit real state first, notify best-effort after" pattern
poll_golf_live_scores.py already uses - so a push failure never causes
the same swing to re-alert every 12-hour refresh cycle.

RUN:
    python3 scripts/detect_odds_swings.py
"""

import json
import os
from pathlib import Path

import psycopg2
import psycopg2.extras
from pywebpush import WebPushException, webpush

ROOT = Path(__file__).resolve().parent.parent

# Goal/assist/booking are real probabilities (0-1 scale, see migration
# 0120's own comment on why shot_on_target is different) - 0.15 is a 15
# percentage-point swing, e.g. 20% -> 35% to score. shot_on_target stores
# an expected COUNT (typically 0-3), so a percentage-point threshold
# doesn't apply the same way - 0.5 there means "half a shot" swung,
# roughly comparable in real-world magnitude. First-cut constants, not
# yet calibrated against real observed swing history (none existed
# before this script) - see feedback_calibration_layer_discipline.
SWING_THRESHOLDS = {
    "goal": 0.15,
    "assist": 0.15,
    "booking": 0.15,
    "shot_on_target": 0.5,
}

MARKET_LABELS = {
    "goal": "to score",
    "assist": "to assist",
    "booking": "to be booked",
    "shot_on_target": "shots on target",
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


def find_swings(cur):
    """Latest-vs-previous pair per (player_id, fixture_id, market), only
    where the latest row hasn't been alerted on yet - a plain windowed
    self-join, same shape as any "most recent 2 rows per group" query."""
    cur.execute(
        """
        with ranked as (
            select
                id, player_id, fixture_id, market, value, observed_at, alerted,
                row_number() over (partition by player_id, fixture_id, market order by observed_at desc) as rn
            from bookmaker_player_probability_history
        )
        select
            cur.id as current_id, cur.player_id, cur.fixture_id, cur.market,
            cur.value as current_value, prev.value as previous_value
        from ranked cur
        join ranked prev
            on prev.player_id = cur.player_id and prev.fixture_id = cur.fixture_id
            and prev.market = cur.market and prev.rn = cur.rn + 1
        where cur.rn = 1 and cur.alerted = false
        """
    )
    return cur.fetchall()


def fetch_context(cur, player_id, fixture_id):
    cur.execute(
        """
        select p.full_name, t.name as team_name,
               f.home_team_id, f.away_team_id, f.kickoff_at,
               th.name as home_name, ta.name as away_name
        from players p
        join teams t on t.id = p.team_id
        join fixtures f on f.id = %s
        join teams th on th.id = f.home_team_id
        join teams ta on ta.id = f.away_team_id
        where p.id = %s
        """,
        (fixture_id, player_id),
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
        swings = find_swings(cur)
        flagged = []
        for row in swings:
            threshold = SWING_THRESHOLDS[row["market"]]
            delta = float(row["current_value"]) - float(row["previous_value"])
            if abs(delta) < threshold:
                continue
            flagged.append((row, delta))

        if not flagged:
            print(f"Checked {len(swings)} player-market pair(s) with a real prior observation - no swings cleared threshold.")
            return

        print(f"{len(flagged)} odds swing(s) detected - marking alerted and notifying ...")

        # Mark alerted + commit BEFORE attempting any notification - a
        # real detected swing is worth recording even if the push step
        # below fails, and this stops the same swing re-firing every
        # refresh cycle regardless of notification outcome.
        for row, _ in flagged:
            cur.execute("update bookmaker_player_probability_history set alerted = true where id = %s", (row["current_id"],))
        conn.commit()

        try:
            cur.execute("select id, endpoint, p256dh, auth from push_subscriptions where is_active")
            subscriptions = cur.fetchall()
            if not subscriptions:
                print("No active push subscriptions - nothing to send.")
                return

            sent = 0
            for row, delta in flagged:
                ctx = fetch_context(cur, row["player_id"], row["fixture_id"])
                if not ctx:
                    continue
                opponent = ctx["away_name"] if ctx["team_name"] == ctx["home_name"] else ctx["home_name"]
                direction = "shortened" if delta > 0 else "drifted"
                label = MARKET_LABELS[row["market"]]
                title = f"{ctx['full_name']} odds {direction} - {label}"
                body = f"{row['previous_value']:.2f} -> {row['current_value']:.2f} vs {opponent} ({ctx['team_name']})"
                tag = f"odds-swing-{row['current_id']}"
                for subscription in subscriptions:
                    if send_push(cur, subscription, title, body, tag):
                        sent += 1
                print(f"  {ctx['full_name']} ({row['market']}): {row['previous_value']:.2f} -> {row['current_value']:.2f}")

            print(f"Sent {sent} push notification(s).")
            conn.commit()  # subscription deactivations from send_push, if any
        except Exception as e:
            conn.rollback()
            print(f"Notification step failed (swing detection above is already saved): {e}")
    except Exception:
        conn.rollback()
        raise
    finally:
        cur.close()
        conn.close()


if __name__ == "__main__":
    main()
