"""
deactivate_relegated_dreamteam_players.py
------------------------------------------
One-off, logged, reversible data fix. Dream Team has no live 2026/27
squad source yet (known limitation - see AGENTS/reference memory), so
its game_players.is_active flags still reflect last season's Premier
League membership. FanTeam's live-sourced roster (import_fanteam_live.py)
already confirms West Ham, Wolverhampton Wanderers and Burnley have ZERO
active players this season - they're not in the 2026/27 top flight - yet
Dream Team was still carrying 100 active players across those 3 clubs,
which is what scripts/audit_player_role.py's "100 stale players" finding
actually was (not a fixture-import gap, as first suspected - corrected
by the user).

Sets game_players.is_active = false for those 100 rows, DREAM TEAM ONLY.
Reversible (flip the flag back), no deletes, no other table touched.
Logs the exact before-state of every affected row to stdout AND a JSON
file before writing anything, so the change is auditable independent of
this script's own commit message.

RUN:
    python3 scripts/deactivate_relegated_dreamteam_players.py            # dry run, logs only
    python3 scripts/deactivate_relegated_dreamteam_players.py --apply    # logs, then writes
"""
import json
import os
import sys
from datetime import datetime, timezone
from pathlib import Path

import psycopg2
import psycopg2.extras

ROOT = Path(__file__).resolve().parent.parent
RELEGATED_TEAM_IDS = (19, 20, 6)  # West Ham United, Wolverhampton Wanderers, Burnley


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

    # Scope check 1: restrict to Dream Team's game_id only.
    cur.execute("select id from fantasy_games where slug = 'dreamteam'")
    dreamteam_id = cur.fetchone()["id"]

    # Scope check 2: no current 2026/27 Dream Team fixture references
    # these 3 teams - confirms there is genuinely nothing to project for
    # them under this game, not just an odds-provider publishing gap.
    cur.execute(
        """
        select count(*) as n
        from game_fixture_gameweeks gfg
        join fixtures f on f.id = gfg.fixture_id
        where gfg.game_id = %s
          and (f.home_team_id = any(%s) or f.away_team_id = any(%s))
        """,
        (dreamteam_id, list(RELEGATED_TEAM_IDS), list(RELEGATED_TEAM_IDS)),
    )
    fixture_refs = cur.fetchone()["n"]
    print(f"Dream Team fixtures referencing the 3 relegated clubs: {fixture_refs} (expect 0)")
    if fixture_refs:
        raise SystemExit("Refusing to proceed - Dream Team DOES reference a fixture for one of these clubs. Investigate before deactivating.")

    # Log the exact affected rows BEFORE any write.
    cur.execute(
        """
        select gp.id as game_player_id, gp.player_id, p.full_name, t.id as team_id, t.name as team_name,
               gp.is_active as is_active_before
        from game_players gp
        join players p on p.id = gp.player_id
        join teams t on t.id = p.team_id
        where gp.game_id = %s and gp.is_active = true and p.team_id = any(%s)
        order by t.name, p.full_name
        """,
        (dreamteam_id, list(RELEGATED_TEAM_IDS)),
    )
    affected = cur.fetchall()
    print(f"\nAffected rows: {len(affected)}")
    for r in affected:
        print(f"  game_player_id={r['game_player_id']:5d}  player_id={r['player_id']:5d}  {r['full_name']:28s}  {r['team_name']:24s}  is_active_before={r['is_active_before']}")

    log_path = ROOT / f"deactivate_relegated_dreamteam_players_{datetime.now(timezone.utc).strftime('%Y%m%dT%H%M%SZ')}.json"
    log_path.write_text(json.dumps([dict(r) for r in affected], indent=2, default=str))
    print(f"\nLogged affected rows to {log_path}")

    if not apply:
        print("\nDry run only (no --apply flag) - no rows changed.")
        cur.close()
        conn.close()
        return

    affected_ids = [r["game_player_id"] for r in affected]
    cur.execute(
        "update game_players set is_active = false, updated_at = now() where id = any(%s) and game_id = %s",
        (affected_ids, dreamteam_id),
    )
    changed = cur.rowcount
    conn.commit()
    print(f"\nApplied: {changed} rows set is_active = false (Dream Team only).")
    cur.close()
    conn.close()


if __name__ == "__main__":
    main()
