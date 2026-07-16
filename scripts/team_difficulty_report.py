"""
team_difficulty_report.py
---------------------------
Demonstrates the team_fixture_difficulty view: ranks teams by attacking
opportunity and clean-sheet opportunity within a date window, for a
given fantasy game. Fixture quantity falls out naturally - a team with
two fixtures in the window just gets two summed rows, no separate
multiplier needed.

There's no real gameweek calendar yet (neither game has published their
2026/27 schedule), so this takes a plain date range rather than a
gameweek number - swap in real gameweek-to-date mapping once that
exists and this becomes a one-line change.

RUN:
    python3 scripts/team_difficulty_report.py dreamteam 2026-08-14 2026-08-25
"""

import os
import sys
from pathlib import Path

import psycopg2

ROOT = Path(__file__).resolve().parent.parent


def load_env():
    for line in (ROOT / ".env").read_text().splitlines():
        line = line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, _, value = line.partition("=")
        os.environ.setdefault(key.strip(), value.strip())


def main():
    if len(sys.argv) != 4:
        print("Usage: python3 team_difficulty_report.py <game_slug> <start_date> <end_date>")
        sys.exit(1)

    game_slug, start_date, end_date = sys.argv[1], sys.argv[2], sys.argv[3]

    load_env()
    conn = psycopg2.connect(os.environ["DATABASE_URL"])
    cur = conn.cursor()

    cur.execute(
        """
        select t.name,
               count(*) as fixture_count,
               round(sum(tfd.attack_score)::numeric, 3) as attack_score,
               round(sum(tfd.clean_sheet_score)::numeric, 3) as clean_sheet_score,
               string_agg(to_char(tfd.kickoff_at, 'Mon DD') || ' vs ' ||
                          (select name from teams where id =
                              case when f.home_team_id = tfd.team_id then f.away_team_id else f.home_team_id end),
                          '; ' order by tfd.kickoff_at)
        from team_fixture_difficulty tfd
        join fantasy_games fg on fg.id = tfd.game_id
        join teams t on t.id = tfd.team_id
        join fixtures f on f.id = tfd.fixture_id
        where fg.slug = %s
          and tfd.kickoff_at >= %s
          and tfd.kickoff_at < %s
        group by t.name
        order by attack_score desc
        """,
        (game_slug, start_date, end_date),
    )
    rows = cur.fetchall()
    conn.close()

    if not rows:
        print("No fixtures found in that window for this game - check the date range or that odds have been ingested.")
        return

    print(f"{'Team':<22}{'Fixtures':<10}{'Attack':<10}{'CleanSheet':<12}Opponents")
    for name, count, attack, clean_sheet, opponents in rows:
        print(f"{name:<22}{count:<10}{attack:<10}{clean_sheet:<12}{opponents}")


if __name__ == "__main__":
    main()
