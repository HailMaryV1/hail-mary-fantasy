"""
archive_golf_squads.py
------------------------
One-off, logged, reversible data fix. Every FanTeam Golf squad is tied to
one specific, already-completed tournament (see migration 0080's own
comment) - there's no live season for them to keep syncing against, yet
getSquadStatuses (frontend/src/lib/squadStatus.ts) was running a real
budget/next-gameweek-score computation for every one of them on every
page load, same as a live season-long squad. Sets squads.is_archived =
true for every real fanteam-golf squad, which getSquadStatuses now skips
entirely (frontend/src/lib/squadStatus.ts) - the historical "what was
projected vs what actually happened" data these squads exist for lives
in golf_tournament_predictions and is read directly by
/golf/algorithm-performance, unaffected by this flag.

Reversible (flip the flag back), no deletes, no other table touched.
Logs the exact before-state of every affected row before writing
anything, so the change is auditable independent of this script's own
commit message.

RUN:
    python3 scripts/archive_golf_squads.py            # dry run, logs only
    python3 scripts/archive_golf_squads.py --apply     # logs, then writes
"""
import json
import os
import sys
from datetime import datetime, timezone
from pathlib import Path

import psycopg2
import psycopg2.extras

ROOT = Path(__file__).resolve().parent.parent


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


def main():
    apply = "--apply" in sys.argv[1:]
    load_env()
    conn = psycopg2.connect(os.environ["DATABASE_URL"])
    cur = conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor)

    cur.execute(
        """
        select s.id as squad_id, s.name, s.is_archived as is_archived_before,
               gt.name as tournament_name, gt.start_time
        from squads s
        join fantasy_games fg on fg.id = s.game_id
        left join golf_tournaments gt on gt.id = s.golf_tournament_id
        where fg.slug = 'fanteam-golf'
        order by gt.start_time desc nulls last, s.id
        """
    )
    affected = cur.fetchall()
    print(f"Real fanteam-golf squads: {len(affected)}")
    for r in affected:
        print(
            f"  squad_id={r['squad_id']:4d}  {r['name']:24s}  {r['tournament_name'] or 'no tournament':24s}  "
            f"is_archived_before={r['is_archived_before']}"
        )

    already_archived = [r for r in affected if r["is_archived_before"]]
    if already_archived:
        print(f"\n{len(already_archived)} already archived - left unchanged, no error.")

    log_path = ROOT / f"archive_golf_squads_{datetime.now(timezone.utc).strftime('%Y%m%dT%H%M%SZ')}.json"
    log_path.write_text(json.dumps([dict(r) for r in affected], indent=2, default=str))
    print(f"\nLogged affected rows to {log_path}")

    if not apply:
        print("\nDry run only (no --apply flag) - no rows changed.")
        cur.close()
        conn.close()
        return

    squad_ids = [r["squad_id"] for r in affected]
    cur.execute("update squads set is_archived = true, updated_at = now() where id = any(%s)", (squad_ids,))
    changed = cur.rowcount
    conn.commit()
    print(f"\nApplied: {changed} rows set is_archived = true.")
    cur.close()
    conn.close()


if __name__ == "__main__":
    main()
