"""
accrue_free_transfers.py
-------------------------
The "live 'a new gameweek has started' trigger" that migration
0022_transfer_rules.sql's own docstring (and this project's GW1 launch
checklist, item 3) flagged as a known, real gap: FanTeam's real rule is
+1 free transfer per gameweek, banked up to 37 (see
frontend-v2/src/lib/transferEconomy.ts's MAX_BANKED_FREE_TRANSFERS) -
until now nothing ever applied that "+1" to the real squads.free_transfers
column as real gameweeks actually passed; makeFanteamTransfer
(frontend-v2/src/app/fanteam/actions.ts) only ever counted transfers DOWN.

"A gameweek has started" is detected the same real-data-grounded way
capture_gameweek_actuals.py's Cloud FF path already does: a gameweek
counts as complete once every one of its real fixtures kicked off at
least 3 hours ago. squads.free_transfers_accrued_through_gameweek
(migration 0096) makes this idempotent - safe to run on every twice-
daily refresh_all.py cycle without double-crediting a gameweek already
processed, and safe to catch up several completed gameweeks at once in
one pass if the pipeline was ever down for a while.

Wildcard interaction needs no special-casing: activating a wildcard
already resets free_transfers to 0 at the moment of use (in
makeFanteamTransfer) - this script just adds its normal +1 on top of
whatever free_transfers currently holds once that gameweek completes,
which is exactly the real rule (a wildcard resets the bank, it doesn't
disable the next gameweek's accrual).

Currently a no-op while pre-season (no FanTeam gameweek has completed
yet - GW1 kicks off 2026-08-21) - that's the correct, expected behaviour,
not a bug. First real accrual happens once GW1 completes (crediting
squads for GW1, unlocking GW2's fresh allotment).

RUN:
    python3 scripts/accrue_free_transfers.py
"""
import os
from pathlib import Path

import psycopg2

ROOT = Path(__file__).resolve().parent.parent

# Mirrors frontend-v2/src/lib/transferEconomy.ts's MAX_BANKED_FREE_TRANSFERS -
# duplicated across Python/TS same as this repo's other cross-language
# constants (e.g. LINEUP_MULTIPLIERS/playerStatus.ts), no shared module
# between the pipeline and the frontend.
MAX_BANKED_FREE_TRANSFERS = 37


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


def main():
    load_env()
    conn = psycopg2.connect(os.environ["DATABASE_URL"])
    conn.autocommit = False
    cur = conn.cursor()

    try:
        cur.execute("select id from fantasy_games where slug = 'fanteam'")
        row = cur.fetchone()
        if not row:
            print("No fanteam fantasy_games row - skipping free-transfer accrual.")
            return
        game_id = row[0]

        cur.execute(
            """
            select distinct gfg.gameweek
            from game_fixture_gameweeks gfg
            join fixtures f on f.id = gfg.fixture_id
            where gfg.game_id = %s
            group by gfg.gameweek
            having max(f.kickoff_at) < now() - interval '3 hours'
            order by gfg.gameweek
            """,
            (game_id,),
        )
        completed_gameweeks = [r[0] for r in cur.fetchall()]
        if not completed_gameweeks:
            print("No completed FanTeam gameweeks yet - nothing to accrue.")
            return
        max_completed = max(completed_gameweeks)
        # Gameweek N completing is what grants gameweek N+1's allotment,
        # not gameweek N's own (that one was already granted at N's own
        # start - free_transfers_accrued_through_gameweek's default of 1
        # already covers GW1's initial signup credit). Caught live in a
        # rolled-back dry run: without the +1 here, GW1 completing did
        # nothing at all, since accrued_through already defaulted to 1.
        target_gameweek = max_completed + 1

        cur.execute(
            "select id, free_transfers, free_transfers_accrued_through_gameweek "
            "from squads where game_id = %s and is_archived = false",
            (game_id,),
        )
        squads = cur.fetchall()

        updated = 0
        for squad_id, free_transfers, accrued_through in squads:
            if accrued_through >= target_gameweek:
                continue
            gained = target_gameweek - accrued_through
            new_free_transfers = min(free_transfers + gained, MAX_BANKED_FREE_TRANSFERS)
            cur.execute(
                "update squads set free_transfers = %s, free_transfers_accrued_through_gameweek = %s where id = %s",
                (new_free_transfers, target_gameweek, squad_id),
            )
            updated += 1

        conn.commit()
        print(
            f"Accrued free transfers for {updated} of {len(squads)} FanTeam squad(s) "
            f"through gameweek {target_gameweek} (completed gameweeks: {completed_gameweeks})."
        )
    except Exception:
        conn.rollback()
        raise
    finally:
        cur.close()
        conn.close()


if __name__ == "__main__":
    main()
