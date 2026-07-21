"""
activity_log.py
------------------
One shared helper for writing to the activity_log table (migration
0031) - used by import_fanteam_live.py, scripts/import_fixtures_odds.py,
and scripts/compute_projections.py, each at the exact point they already
detect a new player/team change/fixture change/score change, so there's
one INSERT statement, not three copies of it.

Not a standalone script - imported, no RUN section.
"""

import json


def log_event(cur, event_type, summary, *, game_id=None, game_player_id=None, fixture_id=None, details=None):
    cur.execute(
        """
        insert into activity_log (event_type, game_id, game_player_id, fixture_id, summary, details)
        values (%s, %s, %s, %s, %s, %s)
        """,
        (event_type, game_id, game_player_id, fixture_id, summary, json.dumps(details or {}, default=str)),
    )
