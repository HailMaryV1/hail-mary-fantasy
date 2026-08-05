"""
capture_squad_gameweek_state.py
--------------------------------
Automatically records "what team/captain/booster I had saved for the
week" the moment a gameweek's deadline (earliest kickoff, same
approximation used everywhere else in this codebase) passes - without
requiring the user to ever press the frontend's manual "Save Team"
button (squad_gameweek_locks, migration 0043). This is what lets Mary
Performance Lab compare a real, deadline-final squad against what she
recommended, for squads whose owner never clicks Save Team.

Deliberately narrow scope, matching the deadline-reactive pattern of
capture_gameweek_predictions.py: for each game with a published
calendar, only the single most-recently-passed gameweek is a capture
candidate on any given run - not a backfill across every past gameweek.
Backfilling further back would mean writing a "snapshot" of a gameweek
using the squad's CURRENT state, which may already reflect transfers
made for gameweeks after the one being backfilled - wrong history, not
missing history. Run twice daily via refresh_all.py, the same cadence
capture_gameweek_predictions.py already uses, keeps the gap between a
deadline passing and this script confirming it small.

Only fills genuine gaps - never overwrites an existing
squad_gameweek_locks row (whether from a manual Save Team press or an
earlier run of this same script), same "insert if missing, never
clobber a real decision" reasoning as capture_gameweek_predictions.py's
locked_at gate.

lineup_snapshot's shape here is an object (not the older plain player
array squads/actions.ts's saveTeamForGameweek writes) - enriches the
existing jsonb column with captain/vice-captain/booster state, which
Save Team's snapshot never captured. Both shapes coexist in the same
column; nothing reads this table across games as though every row
shared one schema.

RUN:
    python3 scripts/capture_squad_gameweek_state.py
"""

import datetime
import os
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


def fetch_last_passed_gameweek_by_game(cur, now):
    """{game_id: gameweek} for the single most-recently-passed deadline
    per game - same min(kickoff_at) deadline approximation as
    capture_gameweek_predictions.py/getSeasonTiming."""
    cur.execute(
        """
        select gfg.game_id, gfg.gameweek, min(f.kickoff_at) as deadline
        from game_fixture_gameweeks gfg
        join fixtures f on f.id = gfg.fixture_id
        group by gfg.game_id, gfg.gameweek
        """
    )
    last_passed = {}
    for game_id, gameweek, deadline in cur.fetchall():
        if deadline > now:
            continue
        if game_id not in last_passed or gameweek > last_passed[game_id]:
            last_passed[game_id] = gameweek
    return last_passed


def fetch_squads_missing_lock(cur, game_id, gameweek):
    cur.execute(
        """
        select s.id, s.captain_game_player_id, s.vice_captain_game_player_id,
               s.active_booster, s.active_booster_gameweek
        from squads s
        where s.game_id = %s and s.is_archived = false
          and not exists (
            select 1 from squad_gameweek_locks l
            where l.squad_id = s.id and l.gameweek = %s
          )
        """,
        (game_id, gameweek),
    )
    return cur.fetchall()


def fetch_squad_players(cur, squad_id):
    cur.execute(
        "select game_player_id, is_starting, bench_order from squad_players where squad_id = %s",
        (squad_id,),
    )
    return [{"game_player_id": gid, "is_starting": is_starting, "bench_order": bench_order} for gid, is_starting, bench_order in cur.fetchall()]


def main():
    load_env()
    conn = psycopg2.connect(os.environ["DATABASE_URL"])
    conn.autocommit = False
    cur = conn.cursor()

    try:
        now = datetime.datetime.now(datetime.timezone.utc)
        last_passed_by_game = fetch_last_passed_gameweek_by_game(cur, now)

        captured = 0
        for game_id, gameweek in last_passed_by_game.items():
            squads = fetch_squads_missing_lock(cur, game_id, gameweek)
            for squad_id, captain_id, vice_captain_id, active_booster, active_booster_gameweek in squads:
                players = fetch_squad_players(cur, squad_id)
                if not players:
                    continue  # empty/unfinished squad - nothing real to snapshot

                snapshot = {
                    "players": players,
                    "captain_game_player_id": captain_id,
                    "vice_captain_game_player_id": vice_captain_id,
                    # Only meaningful if it was still active for this exact
                    # gameweek - a booster left active from an earlier
                    # gameweek's pick shouldn't be recorded as this
                    # gameweek's real choice.
                    "active_booster": active_booster if active_booster_gameweek == gameweek else None,
                }

                cur.execute(
                    """
                    insert into squad_gameweek_locks (squad_id, gameweek, locked_at, lineup_snapshot)
                    values (%s, %s, %s, %s)
                    on conflict (squad_id, gameweek) do nothing
                    """,
                    (squad_id, gameweek, now, psycopg2.extras.Json(snapshot)),
                )
                captured += cur.rowcount

        conn.commit()
        print(f"Captured {captured} new squad-gameweek snapshot(s) across {len(last_passed_by_game)} game(s).")
    except Exception:
        conn.rollback()
        raise
    finally:
        cur.close()
        conn.close()


if __name__ == "__main__":
    main()
