"""
dedupe_fixture_reissues.py
------------------------------
One-time cleanup for the fixture-duplication bug found live 2026-08-27
(user report: "Charlton Athletic"/"Luton" each showing twice on a
player's fixture window - 1-2 days apart). Root cause (see
import_fixtures_odds.py's upsert_fixture and import_fanteam_live.py/
import_cloudff.py's import_fixtures, all fixed alongside this script):
whenever a fixture's kickoff time changed - either The Odds API
reissuing a cup tie under a new external_id once its real slot was
confirmed, or FanTeam/Cloud FF's own live feed reporting an updated
time that no longer matched this table's placeholder - the OLD import
logic failed to find the existing row and inserted a brand new one for
the same real match instead of updating it in place. Confirmed live: 9
EFL Cup pairs + 25 Premier League pairs, all from one identifiable
event each (a specific reschedule/reissue), not random noise.

Each duplicate group is (competition, season, home_team_id,
away_team_id) - the real natural key for a normal fixture (the same two
teams only meet once at a given venue, in a given competition, in a
given season). The row to KEEP is whichever one is still being actively
priced (the freshest fixture_odds.fetched_at, tie-broken by more odds
rows, tie-broken by the later created_at) - confirmed live across every
duplicate pair found that this always agrees with "the one created
later, after the reschedule/reissue was confirmed."

Before deleting the stale row, any game whose game_fixture_gameweeks
only references the STALE id gets a fresh mapping onto the KEEP id at
the same gameweek number (so no game silently loses that fixture from
its calendar) - checked live 2026-08-27 that this genuinely differs per
game: Cloud FF already had both ids mapped (a live duplicate), while
Dream Team/FanTeam only had the stale one (would have gone MISSING, not
merely duplicated, without this step).

fixture_expected_goals/player_prop_baselines are the only two fixture_id
foreign keys NOT set ON DELETE CASCADE (checked live via information_
schema) - their stale-id rows are deleted explicitly first so the
fixture delete itself doesn't hit a FK violation. Every other
referencing table (fixture_odds, fixture_probabilities, game_fixture_
gameweeks, fixture_strength_model_probabilities, fixture_clean_sheet_
probabilities, etc.) cascades automatically.

Prints a full dry-run summary; only writes when --apply is passed.

RUN:
    python3 scripts/dedupe_fixture_reissues.py            # dry run
    python3 scripts/dedupe_fixture_reissues.py --apply     # writes
"""

import os
import sys
from pathlib import Path

import psycopg2

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
    apply = "--apply" in sys.argv
    load_env()
    conn = psycopg2.connect(os.environ["DATABASE_URL"])
    conn.autocommit = False
    cur = conn.cursor()

    try:
        cur.execute(
            """
            select competition, season, home_team_id, away_team_id, array_agg(id order by id)
            from fixtures
            group by competition, season, home_team_id, away_team_id
            having count(*) > 1
            order by competition, min(id)
            """
        )
        groups = cur.fetchall()
        if not groups:
            print("No duplicate fixture groups found.")
            return

        print(f"{len(groups)} duplicate fixture group(s) found.\n")

        total_stale = 0
        for competition, season, home_id, away_id, ids in groups:
            cur.execute(
                "select f.id, t1.name, t2.name, f.kickoff_at, f.created_at, o.cnt, o.latest "
                "from fixtures f "
                "join teams t1 on t1.id = f.home_team_id "
                "join teams t2 on t2.id = f.away_team_id "
                "left join (select fixture_id, count(*) as cnt, max(fetched_at) as latest from fixture_odds group by fixture_id) o "
                "  on o.fixture_id = f.id "
                "where f.id = any(%s)",
                (ids,),
            )
            rows = cur.fetchall()
            # keep = most recent odds fetch (nulls last), tie-break more odds rows, tie-break later created_at
            rows.sort(key=lambda r: (r[6] is not None, r[6], r[5] or 0, r[4]), reverse=True)
            keep = rows[0]
            stale = rows[1:]
            keep_id = keep[0]

            print(f"[{competition}] {keep[1]} vs {keep[2]} ({season})")
            print(f"  KEEP  id={keep_id} kickoff={keep[3]} odds_rows={keep[5] or 0} latest_fetch={keep[6]}")
            for s in stale:
                print(f"  STALE id={s[0]} kickoff={s[3]} odds_rows={s[5] or 0} latest_fetch={s[6]}")

            for s in stale:
                stale_id = s[0]
                total_stale += 1

                cur.execute(
                    "select game_id, gameweek from game_fixture_gameweeks where fixture_id = %s",
                    (stale_id,),
                )
                stale_mappings = cur.fetchall()
                for game_id, gameweek in stale_mappings:
                    cur.execute(
                        "select 1 from game_fixture_gameweeks where game_id = %s and fixture_id = %s",
                        (game_id, keep_id),
                    )
                    if cur.fetchone() is None:
                        print(f"    -> migrating game_id={game_id} GW{gameweek} mapping from stale id={stale_id} to keep id={keep_id}")
                        if apply:
                            cur.execute(
                                "insert into game_fixture_gameweeks (game_id, fixture_id, gameweek) values (%s, %s, %s) "
                                "on conflict (game_id, fixture_id) do nothing",
                                (game_id, keep_id, gameweek),
                            )
                    else:
                        print(f"    -> game_id={game_id} already has keep id={keep_id} mapped (dropping stale duplicate mapping)")

                if apply:
                    cur.execute("delete from fixture_expected_goals where fixture_id = %s", (stale_id,))
                    cur.execute("delete from player_prop_baselines where fixture_id = %s", (stale_id,))
                    cur.execute("delete from fixtures where id = %s", (stale_id,))
            print()

        print(f"Total stale fixture rows: {total_stale}")
        if apply:
            conn.commit()
            print("Applied.")
        else:
            conn.rollback()
            print("Dry run only - re-run with --apply to write.")
    except Exception:
        conn.rollback()
        raise
    finally:
        cur.close()
        conn.close()


if __name__ == "__main__":
    main()
