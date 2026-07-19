"""
verify_player_status_mapping.py
---------------------------------
compute_projections.py's LINEUP_MULTIPLIERS/STATUS_MULTIPLIERS are a
best-guess mapping of FanTeam's raw lineup/status strings to its own
STA/BEN/NOT/EXP/MAY/NES/INJ/SUS/N-A/OFF badges - unconfirmed as of
2026-07-19 because every player currently shows the same two values
("expected" / "not_started").

This prints every distinct (lineup, status) combination currently in
fanteam_player_status, how many players have it, a couple of example
names, and whether compute_projections.py's dicts actually recognize
each raw value (imported directly, so there's exactly one source of
truth to check against - not a second list that can drift).

Run this once FanTeam's live data starts showing real variance (team
news gets published close to a gameweek's lock, typically the final
24-72h before kickoff) - cross-check a handful of flagged/example
players against FanTeam's own site badges, then correct
LINEUP_MULTIPLIERS/STATUS_MULTIPLIERS in compute_projections.py (and the
mirrored dicts in frontend/src/lib/playerStatus.ts) if anything doesn't
match.

RUN:
    python3 scripts/verify_player_status_mapping.py
"""

import os
import sys
from pathlib import Path

import psycopg2

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(Path(__file__).resolve().parent))

from compute_projections import LINEUP_MULTIPLIERS, STATUS_MULTIPLIERS  # noqa: E402


def load_env():
    for line in (ROOT / ".env").read_text().splitlines():
        line = line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, _, value = line.partition("=")
        os.environ.setdefault(key.strip(), value.strip())


def main():
    load_env()
    conn = psycopg2.connect(os.environ["DATABASE_URL"])
    cur = conn.cursor()

    cur.execute(
        """
        select s.lineup, s.status, count(*) as n,
               string_agg(p.full_name, ', ' order by p.full_name) filter (where rn <= 3) as examples
        from (
            select s.*, row_number() over (partition by s.lineup, s.status order by s.game_player_id) as rn
            from fanteam_player_status s
        ) s
        join game_players gp on gp.id = s.game_player_id
        join players p on p.id = gp.player_id
        group by s.lineup, s.status
        order by n desc
        """
    )
    rows = cur.fetchall()
    conn.close()

    if not rows:
        print("No rows in fanteam_player_status yet - run import_fanteam_live.py first.")
        return

    print(f"{'Lineup':<24}{'Status':<16}{'Count':<8}{'Recognized?':<14}Examples")
    for lineup, status, count, examples in rows:
        lineup_ok = lineup in LINEUP_MULTIPLIERS
        status_ok = status in STATUS_MULTIPLIERS
        flag = "OK" if (lineup_ok or lineup is None) and (status_ok or status is None) else "UNRECOGNIZED"
        marker = "" if flag == "OK" else "  ⚠ "
        print(f"{marker}{str(lineup):<24}{str(status):<16}{count:<8}{flag:<14}{examples}")

    unrecognized = [
        (lineup, status)
        for lineup, status, _, _ in rows
        if not ((lineup in LINEUP_MULTIPLIERS or lineup is None) and (status in STATUS_MULTIPLIERS or status is None))
    ]
    if unrecognized:
        print(f"\n{len(unrecognized)} combination(s) not in compute_projections.py's dicts - falling through to 1.0 (no discount).")
        print("If any of these are real INJ/SUS/BEN/etc. values, add them to LINEUP_MULTIPLIERS/STATUS_MULTIPLIERS")
        print("(and the mirrored dicts in frontend/src/lib/playerStatus.ts) with an appropriate multiplier.")
    else:
        print("\nEvery captured value is recognized by compute_projections.py's dicts.")


if __name__ == "__main__":
    main()
