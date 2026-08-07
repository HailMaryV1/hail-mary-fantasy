"""
deactivate_stale_dreamteam_players.py
---------------------------------------
Generalized follow-up to deactivate_relegated_dreamteam_players.py (that
one-off hardcoded 3 relegated club IDs). Dream Team still has no live
2026/27 squad source (see that script's docstring / reference memory),
so its game_players.is_active flags only ever reflect whichever season
they were last set from - they never re-check a player's CURRENT club.
players.team_id is a single global column shared by every game though,
and DOES get kept current by whichever other game's live scraper last
touched that player (FanTeam's live import, EFL Fantasy's import, etc).
So whenever a real individual player transfers out of the Premier
League - not a whole club being relegated, an individual transfer/loan -
Dream Team keeps carrying them as active, and their now-Championship/
League One/Two club name leaks into Dream Team's own team filter
dropdown. Confirmed live 2026-08-07: Paddy McNair (-> Rochdale) and
Gustavo Nunes (-> Swansea City) were exactly this - real transfers,
picked up by another game's importer, invisible to Dream Team's own
(nonexistent) live squad check.

Detection is dynamic rather than a hardcoded team-ID list: any active
Dream Team game_player whose CURRENT team has zero fixtures in Dream
Team's own game_fixture_gameweeks - i.e. a club Dream Team itself
doesn't believe plays any fixtures this season - catches this whole
class of drift (individual transfers AND whole-club relegations) every
time this is re-run, not just the specific players known about today.

Sets game_players.is_active = false, DREAM TEAM ONLY. Reversible (flip
the flag back), no deletes, no other table touched. Logs the exact
before-state of every affected row to stdout AND a JSON file before
writing anything.

RUN:
    python3 scripts/deactivate_stale_dreamteam_players.py            # dry run, logs only
    python3 scripts/deactivate_stale_dreamteam_players.py --apply    # logs, then writes
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

    cur.execute("select id from fantasy_games where slug = 'dreamteam'")
    dreamteam_id = cur.fetchone()["id"]

    cur.execute(
        """
        select gp.id as game_player_id, gp.player_id, p.full_name, t.id as team_id, t.name as team_name,
               gp.is_active as is_active_before
        from game_players gp
        join players p on p.id = gp.player_id
        join teams t on t.id = p.team_id
        where gp.game_id = %s and gp.is_active = true
          and not exists (
            select 1 from game_fixture_gameweeks gfg
            join fixtures f on f.id = gfg.fixture_id
            where gfg.game_id = %s and (f.home_team_id = t.id or f.away_team_id = t.id)
          )
        order by t.name, p.full_name
        """,
        (dreamteam_id, dreamteam_id),
    )
    affected = cur.fetchall()
    print(f"Active Dream Team players whose current club has zero Dream Team fixtures: {len(affected)}")
    for r in affected:
        print(f"  game_player_id={r['game_player_id']:5d}  player_id={r['player_id']:5d}  {r['full_name']:28s}  {r['team_name']:24s}  is_active_before={r['is_active_before']}")

    log_path = ROOT / f"deactivate_stale_dreamteam_players_{datetime.now(timezone.utc).strftime('%Y%m%dT%H%M%SZ')}.json"
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
