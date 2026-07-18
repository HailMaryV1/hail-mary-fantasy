"""
compute_projections.py
------------------------
Hail Mary Score, two ways depending on whether a game has published its
real per-stat scoring matrix (game_scoring_rules):

  v1 (no matrix - currently Dream Team):
    expected_points_per_fixture = points_per_90 * blended_fixture_factor
    Kept exactly as before - one number blending attack + clean-sheet
    opportunity, scaled against a player's own historical points-per-90.

  v2-decomposed (has a matrix - currently FanTeam):
    Projects each individual stat (goals, assists, clean sheets, cards,
    saves...) from the player's own historical per-90 rate, fixture-adjusts
    only the stats a fixture actually predicts, then converts each through
    its REAL point value for that position from game_scoring_rules. This is
    what actually answers "which players are best to target" - the reason
    the matrix was captured in the first place (migration 0021) - instead
    of one blended number that can't be decomposed back into "why".

Both fixture-selection modes (--gameweek N, or a plain date range) and the
"latest projection wins" behaviour downstream are unchanged from v1 - see
KNOWN LIMITATIONS below, carried over plus new ones from the decomposition.

KNOWN LIMITATIONS (v1, unchanged):
  - Dream Team still uses players.team_id with no live squad source (no
    calendar/API available yet - it's off-season). FanTeam's team_id is
    now corrected from its live API (see import_fanteam_live.py), so
    this caveat is FanTeam-resolved but still applies to Dream Team.
  - clean_sheet_score prefers the real team-goals market when it exists
    (migration 0010), falling back to the win% + half-draw% approximation
    otherwise - still mostly the approximation until matches are close.

KNOWN LIMITATIONS (v2-decomposed, new):
  - Matrix line items with no historical data source to project from
    (shot_on_target, caused_penalty, caused_scoring_free_kick,
    penalty_miss, own_goal, positive_impact, negative_impact,
    penalty_save) simply aren't in the projected-stats dict, so they
    contribute 0. Real signal for these would need player-prop odds
    (fixture_player_props) or live in-season stats - neither exists yet
    (see migration 0004's own docstring, and compute_projections' sibling
    scripts - both confirmed empty this far from a live season).
  - "appearance" / "minutes_60_plus" / "played_full_match" are all driven
    by one shared involvement_rate (last season's minutes / a 38-game
    season, uncapped by shrinkage - low minutes IS the signal here, not
    noise to smooth out) rather than separately modelling start vs.
    sub-appearance probability. Simple on purpose - a real minutes model
    needs expected-lineups data this project doesn't have.
  - Saves and goals-conceded are driven by defensive PRESSURE (the inverse
    of clean_sheet_score - a keeper facing a stronger attack makes more
    saves and concedes more), not by the team's own attack_score. Goals/
    assists are driven by attack_score. Cards get no fixture adjustment -
    no fixture signal predicts card risk.

RUN:
    python3 scripts/compute_projections.py fanteam --gameweek 1
    python3 scripts/compute_projections.py dreamteam 2026-08-01 2026-08-31
"""

import json
import os
import sys
from pathlib import Path

import psycopg2
import psycopg2.extras

ROOT = Path(__file__).resolve().parent.parent
HISTORICAL_SEASON = "2025/26"
UPCOMING_SEASON = "2026/27"
POSITIONS = ("GK", "DEF", "MID", "FWD")

DEFAULT_WEIGHTS = {
    "position_weights": {
        "GK": {"attack": 0.0, "clean_sheet": 1.0},
        "DEF": {"attack": 0.3, "clean_sheet": 0.7},
        "MID": {"attack": 0.7, "clean_sheet": 0.3},
        "FWD": {"attack": 1.0, "clean_sheet": 0.0},
    },
    "neutral_attack": 1 / 3,
    "neutral_clean_sheet": 0.5,
    # Shrinkage: blend each player's own points-per-90 toward their
    # position's average, weighted as if we'd additionally observed
    # this many 90-minute games at the average rate. Without this, a
    # player with 20 minutes and one big return gets a wildly inflated
    # rate that isn't predictive of anything - discovered by inspecting
    # v1's first real output (a 2.00-price fringe player topped the
    # list ahead of Haaland) rather than assumed in advance.
    "shrinkage_games": 10,
}

# v2-decomposed reuses neutral_attack/neutral_clean_sheet/shrinkage_games
# from the same DEFAULT_WEIGHTS shape (no position_weights needed - the
# matrix itself already encodes position-specific point values).
DEFAULT_WEIGHTS_V2 = {
    "neutral_attack": DEFAULT_WEIGHTS["neutral_attack"],
    "neutral_clean_sheet": DEFAULT_WEIGHTS["neutral_clean_sheet"],
    "shrinkage_games": DEFAULT_WEIGHTS["shrinkage_games"],
    # Used only for involvement_rate = minutes_played / 90 / season_games,
    # clipped to 1 - a rough "how nailed-on is this player" proxy.
    "season_games": 38,
}

# stat -> game_player_stats column, for every stat we can actually project
# from last season's totals. Matrix entries with no entry here (shot_on_target,
# caused_penalty, caused_scoring_free_kick, penalty_miss, own_goal,
# positive_impact, negative_impact, penalty_save) contribute 0 - see docstring.
STAT_COLUMNS = {
    "goal": "goals",
    "assist": "assists",
    "clean_sheet_60min": "clean_sheets",
    "save": "saves",
    "goals_conceded_per_2": "goals_conceded",
    "yellow_card": "yellow_cards",
    "red_card": "red_cards",
}
# How each stat's per-90 rate gets fixture-adjusted.
#   "attack": scaled by attack_score / neutral_attack
#   "pressure": scaled by (1 - clean_sheet_score) / (1 - neutral_clean_sheet)
#     (defensive pressure faced - the inverse of clean-sheet probability)
#   "clean_sheet": scaled by clean_sheet_score / neutral_clean_sheet
#   "flat": no fixture adjustment
STAT_FIXTURE_MODE = {
    "goal": "attack",
    "assist": "attack",
    "clean_sheet_60min": "clean_sheet",
    "save": "pressure",
    "goals_conceded_per_2": "pressure",
    "yellow_card": "flat",
    "red_card": "flat",
}
# goals_conceded_per_2's point value in the matrix is "per 2 conceded" -
# our projected rate is per single goal, so halve it before pricing.
STAT_RATE_SCALE = {"goals_conceded_per_2": 0.5}
# involvement-driven stats: no historical column, projected value is just
# involvement_rate itself (capped [0, 1]).
INVOLVEMENT_STATS = ("appearance", "minutes_60_plus", "played_full_match")


def load_env():
    for line in (ROOT / ".env").read_text().splitlines():
        line = line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, _, value = line.partition("=")
        os.environ.setdefault(key.strip(), value.strip())


def get_or_create_algorithm_version(cur, label, description, weights):
    # Upsert, not get-or-create: while iterating pre-season (no real
    # outcomes compared against yet), a weights change is a bug fix, not
    # a new tunable version. Once projections start getting compared
    # against actual results, stop calling this with changed weights
    # under the same label - bump the label instead so history stays honest.
    cur.execute(
        """
        insert into algorithm_versions (version_label, description, weights)
        values (%s, %s, %s)
        on conflict (version_label) do update
            set description = excluded.description, weights = excluded.weights
        returning id, weights
        """,
        (label, description, psycopg2.extras.Json(weights)),
    )
    return cur.fetchone()


def fixture_factor(position, attack_score, clean_sheet_score, weights):
    pw = weights["position_weights"][position]
    neutral_attack = weights["neutral_attack"]
    neutral_clean_sheet = weights["neutral_clean_sheet"]
    return (
        pw["attack"] * (float(attack_score) / neutral_attack)
        + pw["clean_sheet"] * (float(clean_sheet_score) / neutral_clean_sheet)
    )


def fetch_fixtures_by_period(cur, game_id, period_start, period_end):
    cur.execute(
        """
        select p.id as player_id, tfd.fixture_id, tfd.kickoff_at,
               tfd.attack_score, tfd.clean_sheet_score
        from players p
        join team_fixture_difficulty tfd
            on tfd.team_id = p.team_id and tfd.game_id = %s
        where tfd.kickoff_at >= %s and tfd.kickoff_at < %s
        """,
        (game_id, period_start, period_end),
    )
    return cur.fetchall()


def fetch_fixtures_by_gameweek(cur, game_id, gameweek):
    cur.execute(
        """
        select p.id as player_id, tfd.fixture_id, tfd.kickoff_at,
               tfd.attack_score, tfd.clean_sheet_score
        from players p
        join team_fixture_difficulty tfd
            on tfd.team_id = p.team_id and tfd.game_id = %s
        join game_fixture_gameweeks gfg
            on gfg.fixture_id = tfd.fixture_id and gfg.game_id = tfd.game_id and gfg.gameweek = %s
        """,
        (game_id, gameweek),
    )
    return cur.fetchall()


def fetch_scoring_rules(cur, game_id):
    """{(applies_to, stat): points} for this game - empty dict if no matrix exists."""
    cur.execute(
        "select applies_to, stat, points from game_scoring_rules where game_id = %s",
        (game_id,),
    )
    return {(applies_to, stat): float(points) for applies_to, stat, points in cur.fetchall()}


def compute_shrunk_rates(players, historical_rows):
    """
    players: [(game_player_id, position, player_id)]
    historical_rows: {player_id: {minutes_played, goals, assists, clean_sheets,
                                    saves, goals_conceded, yellow_cards, red_cards}}
    Returns (per_player_rates, position_avg_rates) - both per-90, shrunk
    toward the position average using the same shrinkage_games technique
    v1 used for points_per_90, applied per-stat instead of just to the total.
    """
    stat_cols = list(STAT_COLUMNS.values())
    position_totals = {pos: {col: 0.0 for col in stat_cols + ["games90"]} for pos in POSITIONS}
    for _, position, player_id in players:
        row = historical_rows.get(player_id)
        if not row:
            continue
        games90 = row["minutes_played"] / 90.0
        position_totals[position]["games90"] += games90
        for col in stat_cols:
            position_totals[position][col] += row[col]

    position_avg = {}
    for pos in POSITIONS:
        games90 = position_totals[pos]["games90"]
        position_avg[pos] = {
            col: (position_totals[pos][col] / games90 if games90 > 0 else 0.0) for col in stat_cols
        }
    return position_avg


def project_player_stats(position, historical_row, fixture, weights, position_avg):
    """Per-stat projected count for one player's one fixture (v2-decomposed)."""
    k = weights["shrinkage_games"]
    neutral_attack = weights["neutral_attack"]
    neutral_clean_sheet = weights["neutral_clean_sheet"]
    attack_score = float(fixture["attack_score"])
    clean_sheet_score = float(fixture["clean_sheet_score"])

    attack_factor = attack_score / neutral_attack
    clean_sheet_factor = clean_sheet_score / neutral_clean_sheet
    pressure_factor = (1 - clean_sheet_score) / (1 - neutral_clean_sheet)
    factor_by_mode = {"attack": attack_factor, "clean_sheet": clean_sheet_factor, "pressure": pressure_factor, "flat": 1.0}

    games90 = historical_row["minutes_played"] / 90.0
    season_games = weights["season_games"]
    involvement_rate = min(1.0, games90 / season_games)

    projected = {stat: involvement_rate for stat in INVOLVEMENT_STATS}
    for stat, col in STAT_COLUMNS.items():
        raw_rate = (historical_row[col] + k * position_avg[position][col]) / (games90 + k)
        factor = factor_by_mode[STAT_FIXTURE_MODE[stat]]
        rate_scale = STAT_RATE_SCALE.get(stat, 1.0)
        projected[stat] = raw_rate * factor * involvement_rate * rate_scale
    return projected


def price_projected_stats(position, projected_stats, scoring_rules):
    """Sum projected_stats through their real point values for this position."""
    total = 0.0
    priced = {}
    for stat, value in projected_stats.items():
        points = scoring_rules.get(("all", stat), scoring_rules.get((position, stat)))
        if points is None:
            continue
        contribution = value * points
        priced[stat] = {"projected": round(value, 4), "points_each": points, "contribution": round(contribution, 3)}
        total += contribution
    return total, priced


def upsert_projection(cur, algo_id, game_player_id, gameweek, period_start, period_end, score, inputs):
    if gameweek is not None:
        cur.execute(
            """
            insert into projections
                (algorithm_version_id, game_player_id, season, gameweek, period_start, period_end,
                 hail_mary_score, inputs)
            values (%s, %s, %s, %s, %s, %s, %s, %s)
            on conflict (algorithm_version_id, game_player_id, gameweek) where gameweek is not null
                do update set hail_mary_score = excluded.hail_mary_score, inputs = excluded.inputs,
                              period_start = excluded.period_start, period_end = excluded.period_end
            """,
            (algo_id, game_player_id, UPCOMING_SEASON, gameweek, period_start, period_end, round(score, 3),
             psycopg2.extras.Json(inputs)),
        )
    else:
        cur.execute(
            """
            insert into projections
                (algorithm_version_id, game_player_id, season, period_start, period_end,
                 hail_mary_score, inputs)
            values (%s, %s, %s, %s, %s, %s, %s)
            on conflict (algorithm_version_id, game_player_id, period_start, period_end)
                where gameweek is null
                do update set hail_mary_score = excluded.hail_mary_score, inputs = excluded.inputs
            """,
            (algo_id, game_player_id, UPCOMING_SEASON, period_start, period_end, round(score, 3),
             psycopg2.extras.Json(inputs)),
        )


def main():
    args = sys.argv[1:]
    if len(args) == 3 and args[1] == "--gameweek":
        game_slug, gameweek, period_start, period_end = args[0], int(args[2]), None, None
    elif len(args) == 3:
        game_slug, period_start, period_end, gameweek = args[0], args[1], args[2], None
    else:
        print("Usage: python3 compute_projections.py <game_slug> --gameweek <N>")
        print("       python3 compute_projections.py <game_slug> <period_start> <period_end>")
        sys.exit(1)

    load_env()
    conn = psycopg2.connect(os.environ["DATABASE_URL"])
    conn.autocommit = False
    cur = conn.cursor()

    try:
        cur.execute("select id from fantasy_games where slug = %s", (game_slug,))
        row = cur.fetchone()
        if not row:
            raise SystemExit(f"Unknown game slug: {game_slug}")
        game_id = row[0]

        scoring_rules = fetch_scoring_rules(cur, game_id)
        use_v2 = len(scoring_rules) > 0

        if use_v2:
            algo_id, weights = get_or_create_algorithm_version(
                cur, "v2-decomposed",
                "per-stat projection (goals/assists/clean sheets/cards/saves) priced through game_scoring_rules",
                DEFAULT_WEIGHTS_V2,
            )
        else:
            algo_id, weights = get_or_create_algorithm_version(
                cur, "v1", "points_per_90 x position-weighted fixture factor", DEFAULT_WEIGHTS
            )
        if isinstance(weights, str):
            weights = json.loads(weights)

        # Players + last season's historical totals.
        cur.execute(
            """
            select gp.id, p.position, gp.player_id,
                   gps.total_points, gps.minutes_played,
                   gps.goals, gps.assists, gps.clean_sheets, gps.saves,
                   gps.goals_conceded, gps.yellow_cards, gps.red_cards
            from game_players gp
            join players p on p.id = gp.player_id
            join game_player_stats gps
                on gps.game_player_id = gp.id and gps.season = %s and gps.gameweek = 0
            where gp.game_id = %s and gps.minutes_played > 0
            """,
            (HISTORICAL_SEASON, game_id),
        )
        raw_players = cur.fetchall()
        players = [(r[0], r[1], r[2]) for r in raw_players]
        historical_by_player_id = {
            r[2]: {
                "total_points": float(r[3]), "minutes_played": r[4],
                "goals": r[5], "assists": r[6], "clean_sheets": r[7], "saves": r[8],
                "goals_conceded": r[9], "yellow_cards": r[10], "red_cards": r[11],
            }
            for r in raw_players
        }
        game_player_meta = {r[0]: (r[1], r[2]) for r in raw_players}  # game_player_id -> (position, player_id)

        # Position-average points-per-90 (v1) and per-stat position averages (v2),
        # weighted by minutes - not a plain average of individual rates, same
        # small-sample reasoning as the shrinkage above.
        position_totals = {}
        for _, position, _, total_points, minutes_played, *_ in raw_players:
            agg = position_totals.setdefault(position, [0.0, 0.0])
            agg[0] += float(total_points)
            agg[1] += float(minutes_played) / 90.0
        position_avg_pp90 = {pos: pts / games for pos, (pts, games) in position_totals.items()}
        position_avg_rates = compute_shrunk_rates(players, historical_by_player_id)

        if gameweek is not None:
            rows = fetch_fixtures_by_gameweek(cur, game_id, gameweek)
        else:
            rows = fetch_fixtures_by_period(cur, game_id, period_start, period_end)

        fixtures_by_player = {}
        all_kickoffs = []
        for player_id, fixture_id, kickoff_at, attack_score, clean_sheet_score in rows:
            all_kickoffs.append(kickoff_at)
            fixtures_by_player.setdefault(player_id, []).append(
                {"fixture_id": fixture_id, "kickoff_at": kickoff_at.isoformat(),
                 "attack_score": float(attack_score), "clean_sheet_score": float(clean_sheet_score)}
            )

        # Even in gameweek mode, derive a display period from the actual
        # fixture dates found - period_start/period_end stay populated
        # either way, so nothing downstream (frontend) needs a code change.
        if gameweek is not None:
            if not all_kickoffs:
                raise SystemExit(f"No fixtures found for {game_slug} gameweek {gameweek} - has import_fanteam_live.py been run?")
            period_start = min(all_kickoffs).date().isoformat()
            period_end = max(all_kickoffs).date().isoformat()

        written = 0
        for game_player_id, position, player_id in players:
            player_fixtures = fixtures_by_player.get(player_id, [])
            if not player_fixtures:
                continue
            historical_row = historical_by_player_id[player_id]

            if use_v2:
                # A neutral-fixture (factor = 1.0 everywhere) baseline, priced
                # the same way as real fixtures - this is the v2 equivalent of
                # v1's points_per_90, and lets player_projection_summary /
                # player_projection_fixtures (which read inputs->>'points_per_90'
                # and per-fixture fixture_factor) keep working unchanged instead
                # of silently showing 0.0 for every FanTeam player.
                neutral_fixture = {"attack_score": weights["neutral_attack"], "clean_sheet_score": weights["neutral_clean_sheet"]}
                neutral_stats = project_player_stats(position, historical_row, neutral_fixture, weights, position_avg_rates)
                points_per_90, _ = price_projected_stats(position, neutral_stats, scoring_rules)

                score = 0.0
                fixture_breakdown = []
                for fx in player_fixtures:
                    projected_stats = project_player_stats(position, historical_row, fx, weights, position_avg_rates)
                    contribution, priced = price_projected_stats(position, projected_stats, scoring_rules)
                    score += contribution
                    fixture_factor_equiv = contribution / points_per_90 if points_per_90 > 0 else 0.0
                    fixture_breakdown.append({
                        "fixture_id": fx["fixture_id"], "kickoff_at": fx["kickoff_at"],
                        "attack_score": fx["attack_score"], "clean_sheet_score": fx["clean_sheet_score"],
                        "fixture_factor": round(fixture_factor_equiv, 3),
                        "contribution": round(contribution, 3), "stats": priced,
                    })
                inputs = {"points_per_90": round(points_per_90, 3), "fixtures": fixture_breakdown}
            else:
                games_played = historical_row["minutes_played"] / 90.0
                k = weights["shrinkage_games"]
                points_per_90 = (historical_row["total_points"] + k * position_avg_pp90[position]) / (games_played + k)
                score = 0.0
                fixture_breakdown = []
                for fx in player_fixtures:
                    factor = fixture_factor(position, fx["attack_score"], fx["clean_sheet_score"], weights)
                    contribution = points_per_90 * factor
                    score += contribution
                    fixture_breakdown.append({**fx, "fixture_factor": factor, "contribution": contribution})
                inputs = {"points_per_90": round(points_per_90, 3), "fixtures": fixture_breakdown}

            upsert_projection(cur, algo_id, game_player_id, gameweek, period_start, period_end, score, inputs)
            written += 1

        conn.commit()
        label = f"gameweek {gameweek}" if gameweek is not None else f"{period_start} to {period_end}"
        algo_label = "v2-decomposed" if use_v2 else "v1"
        print(f"Wrote {written} projections for {game_slug} ({algo_label}), {label}.")
    except Exception:
        conn.rollback()
        raise
    finally:
        cur.close()
        conn.close()


if __name__ == "__main__":
    main()
