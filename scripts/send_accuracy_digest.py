"""
send_accuracy_digest.py
--------------------------
Real user request 2026-08-21: "surface accuracy patterns to you directly
instead of only living in Performance Lab." Fires one push notification
per squad, once a gameweek's Ask Mary predictions are FULLY graded -
every prediction row for that squad+gameweek already has a matching
prediction_evaluations row - not partially, so a slow-to-evaluate late
fixture doesn't cause a premature "some of this gameweek" digest.

Reuses the exact same success-rate/gain definitions as
frontend-v2/src/lib/performanceAnalytics.ts's computeLifetimeSummary(),
just scoped to one squad+gameweek instead of a whole career, so the
numbers here always agree with what Performance Lab shows for the same
predictions. In particular "applied" mirrors that file's own mapping
(prediction_evaluations.was_followed, null for hold-kind rows - see
dreamteam/performance-lab/page.tsx's `p.kind === "hold" ? null : ...`).

Marks (squad_id, gameweek) into accuracy_digests (migration 0132)
immediately after composing the message, before attempting to send -
same "record real state first, notify best-effort after" pattern
detect_odds_swings.py already uses - so a push failure never causes the
same gameweek to re-digest on the next wrap-up cycle.

Pushed only to the squad's own owner (squads.user_id), unlike
detect_odds_swings.py's broadcast-to-everyone - accuracy is personal to
whoever's squad it is, not a market signal anyone watching would want.

RUN:
    python3 scripts/send_accuracy_digest.py
"""

import json
import os
from pathlib import Path

import psycopg2
import psycopg2.extras
from pywebpush import WebPushException, webpush

ROOT = Path(__file__).resolve().parent.parent


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


def find_ready_gameweeks(cur):
    """Every (squad_id, gameweek) with at least one prediction, where
    EVERY prediction for that squad+gameweek already has a matching
    prediction_evaluations row, and no digest has been sent yet."""
    cur.execute(
        """
        select pr.squad_id, pr.gameweek
        from predictions pr
        left join prediction_evaluations pe on pe.prediction_id = pr.id
        left join accuracy_digests ad on ad.squad_id = pr.squad_id and ad.gameweek = pr.gameweek
        where pr.gameweek is not null and ad.id is null
        group by pr.squad_id, pr.gameweek
        having count(*) = count(pe.id)
        """
    )
    return cur.fetchall()


def fetch_digest_rows(cur, squad_id, gameweek):
    cur.execute(
        """
        select
            pr.kind, pe.actual_gain, pe.transfer_success,
            pe.captain_actual_points, pe.vice_captain_actual_points, pe.captain_success,
            pe.hold_correct, pe.was_followed, pe.counterfactual_gain
        from predictions pr
        join prediction_evaluations pe on pe.prediction_id = pr.id
        where pr.squad_id = %s and pr.gameweek = %s
        """,
        (squad_id, gameweek),
    )
    return cur.fetchall()


def compose_digest(squad_name, game_display_name, gameweek, rows):
    """Builds only the bullet segments that have real data for this
    gameweek - a squad with no transfers this week shouldn't see a
    "0/0 transfers" line, and one with no captain change shouldn't see a
    hollow captain bullet either."""
    transfers = [r for r in rows if r["kind"] == "transfer"]
    captains = [r for r in rows if r["kind"] == "captain"]
    holds = [r for r in rows if r["kind"] == "hold"]

    bullets = []

    transfer_successes = [r for r in transfers if r["transfer_success"] is not None]
    if transfer_successes:
        hit = sum(1 for r in transfer_successes if r["transfer_success"])
        gains = [r["actual_gain"] for r in transfers if r["actual_gain"] is not None]
        net_gain = sum(gains) if gains else 0.0
        sign = "+" if net_gain >= 0 else ""
        bullets.append(f"{hit}/{len(transfer_successes)} transfers paid off ({sign}{net_gain:.1f}pts)")

    captain_successes = [r for r in captains if r["captain_success"] is not None]
    if captain_successes:
        c = captain_successes[0]
        verdict = "hit" if c["captain_success"] else "missed"
        if c["captain_actual_points"] is not None and c["vice_captain_actual_points"] is not None:
            delta = c["captain_actual_points"] - c["vice_captain_actual_points"]
            sign = "+" if delta >= 0 else ""
            bullets.append(f"Captain {verdict} ({sign}{delta:.1f}pts vs VC)")
        else:
            bullets.append(f"Captain {verdict}")

    hold_verdicts = [r for r in holds if r["hold_correct"] is not None]
    if hold_verdicts:
        correct = sum(1 for r in hold_verdicts if r["hold_correct"])
        bullets.append(f"{correct}/{len(hold_verdicts)} holds were the right call")

    unfollowed = [r for r in rows if r["kind"] != "hold" and r["was_followed"] is False and r["counterfactual_gain"] is not None]
    if unfollowed:
        total = sum(r["counterfactual_gain"] for r in unfollowed)
        if total > 0:
            bullets.append(f"Skipped {len(unfollowed)} call(s) that would've gained +{total:.1f}pts")
        elif total < 0:
            bullets.append(f"Skipped {len(unfollowed)} call(s) that would've cost {total:.1f}pts")

    if not bullets:
        return None

    title = f"{squad_name} · {game_display_name} GW{gameweek} report"
    body = " · ".join(bullets)
    return title, body


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
        ready = find_ready_gameweeks(cur)
        if not ready:
            print("No squad+gameweek is both fully graded and not yet digested.")
            return

        print(f"{len(ready)} squad+gameweek combination(s) ready for a digest ...")
        sent = 0
        for entry in ready:
            squad_id, gameweek = entry["squad_id"], entry["gameweek"]
            cur.execute(
                """
                select s.name as squad_name, s.user_id, fg.display_name as game_display_name
                from squads s join fantasy_games fg on fg.id = s.game_id
                where s.id = %s
                """,
                (squad_id,),
            )
            squad = cur.fetchone()
            if not squad:
                continue

            rows = fetch_digest_rows(cur, squad_id, gameweek)
            digest = compose_digest(squad["squad_name"], squad["game_display_name"], gameweek, rows)

            # Recorded as sent regardless of whether there was anything
            # worth saying - an all-holds gameweek with nothing gradable
            # still shouldn't be re-checked every wrap-up cycle forever.
            cur.execute(
                "insert into accuracy_digests (squad_id, gameweek) values (%s, %s) on conflict do nothing",
                (squad_id, gameweek),
            )
            conn.commit()

            if digest is None:
                print(f"  squad {squad_id} GW{gameweek}: nothing gradable to report, skipped.")
                continue

            title, body = digest
            cur.execute("select id, endpoint, p256dh, auth from push_subscriptions where is_active and user_id = %s", (squad["user_id"],))
            subscriptions = cur.fetchall()
            tag = f"accuracy-digest-{squad_id}-{gameweek}"
            for subscription in subscriptions:
                if send_push(cur, subscription, title, body, tag):
                    sent += 1
            conn.commit()  # subscription deactivations from send_push, if any
            print(f"  {title}: {body}")

        print(f"Sent {sent} push notification(s).")
    except Exception:
        conn.rollback()
        raise
    finally:
        cur.close()
        conn.close()


if __name__ == "__main__":
    main()
