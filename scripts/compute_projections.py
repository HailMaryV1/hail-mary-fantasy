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

KNOWN LIMITATIONS (status multiplier, new):
  - LINEUP_MULTIPLIERS / STATUS_MULTIPLIERS below are a best-guess mapping
    of FanTeam's raw `lineup`/`status` strings (captured by
    import_fanteam_live.py into fanteam_player_status - see migration
    0027) to its own STA/BEN/NOT/EXP/MAY/NES/INJ/SUS/N-A/OFF badges - only
    "expected"/"not_started" have been observed live so far (everyone
    shows these, pre-season, ~5 weeks before kickoff). Every other key is
    unverified. Unmatched values fail open to 1.0 by design - a wrong or
    missing guess never wrongly zeroes a score. Run
    scripts/verify_player_status_mapping.py once real variance appears
    (close to matchday) to confirm/correct these.

KNOWN LIMITATIONS (v2-decomposed, updated):
  - shot_on_target, own_goal, and penalty_save are now projected from last
    season's raw_stats (SOT/ownGoals/penaltySaves), same shrinkage +
    fixture-adjustment treatment as the original 7 stats - see
    STAT_COLUMNS. Still contribute 0, with no historical source to project
    from at all: caused_penalty, caused_scoring_free_kick, penalty_miss
    (would need player-prop odds - see fixture_player_props, confirmed
    still empty), and positive_impact/negative_impact (FanTeam's own
    subjective judge-panel stat - not projectable from any data source,
    ever).
  - "appearance" / "minutes_60_plus" / "played_full_match" are now three
    separately shrunk probabilities derived from last season's PT1/PT60/
    PT90 (games featured / games with 60+ minutes / games with a full 90)
    instead of one linear involvement_rate copied across all three - see
    compute_involvement_rates(). Still doesn't model start vs. sub
    appearance as genuinely separate events (a real minutes model needs
    expected-lineups data this project doesn't have) - just a richer
    empirical proxy for the same underlying question.
  - Saves, goals-conceded, and now penalty_save/own_goal are driven by
    defensive PRESSURE (the inverse of clean_sheet_score - a keeper/
    defence facing a stronger attack makes more saves, concedes more, and
    faces/commits more), not by the team's own attack_score. Goals/
    assists/shot_on_target are driven by attack_score. Cards get no
    fixture adjustment - no fixture signal predicts card risk.
  - neutral_attack is now self-calibrating at runtime (mean attack_score
    across this game's fixtures, ~0.380 for the EPL) instead of a
    hardcoded 1/3 three-way-market assumption that ignored the real ~24%
    draw rate - see resolve_neutral_attack(). neutral_clean_sheet stays
    0.5 (provably exact by construction: win+draw+loss=1 summed over both
    fixture sides always averages to 0.5). clean_sheet_score itself still
    prefers the real team-goals market when it exists, falling back to
    the win%+half-draw% approximation otherwise (unchanged - see KNOWN
    LIMITATIONS (v1) above; fixture_clean_sheet_probabilities confirmed
    still empty).
  - v2's inputs now also carries "games90" (sample-size signal) and each
    fixture entry a "predicted_minutes" figure, for the Hail Mary Form
    System (player_gameweek_predictions, migration 0044) to freeze -
    predicted_minutes describes only fixtures[0] (the first fixture), so
    a double gameweek's figure isn't a combined one; hail_mary_score
    itself still correctly sums every fixture in the window.

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

from activity_log import log_event

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

# stat -> game_player_stats column (either a typed column, or a raw_stats
# jsonb key pulled into the historical row dict in main()), for every stat
# we can actually project from last season's totals. Matrix entries with
# no entry here (caused_penalty, caused_scoring_free_kick, penalty_miss,
# positive_impact, negative_impact) contribute 0 - see docstring.
STAT_COLUMNS = {
    "goal": "goals",
    "assist": "assists",
    "clean_sheet_60min": "clean_sheets",
    "save": "saves",
    "goals_conceded_per_2": "goals_conceded",
    "yellow_card": "yellow_cards",
    "red_card": "red_cards",
    "shot_on_target": "shots_on_target",
    "own_goal": "own_goals",
    "penalty_save": "penalty_saves",
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
    "shot_on_target": "attack",  # same driver as goal/assist
    # Weakly-justified but directionally right: DEF/GK own_goal rate
    # (0.163/0.125 per season) is much higher than MID/FWD (0.023/0.05) -
    # a defensive-pressure signature. Magnitude is small enough either way
    # (avg 0.02-0.16/season) that shrinkage(k=10) dominates the projection
    # regardless of which fixture-mode bucket this lands in.
    "own_goal": "pressure",
    # Same bucket as save - a keeper facing a stronger attack sees (and
    # saves) more penalties. Meaningful magnitude here (GK avg 0.275/
    # season, ~1 in 4 keepers), worth getting right.
    "penalty_save": "pressure",
}
# goals_conceded_per_2's point value in the matrix is "per 2 conceded" -
# our projected rate is per single goal, so halve it before pricing.
STAT_RATE_SCALE = {"goals_conceded_per_2": 0.5}

# v2-decomposed reuses neutral_clean_sheet/shrinkage_games from the same
# DEFAULT_WEIGHTS shape (no position_weights needed - the matrix itself
# already encodes position-specific point values).
DEFAULT_WEIGHTS_V2 = {
    # Resolved at runtime via resolve_neutral_attack() - mean(attack_score)
    # over team_fixture_difficulty for this game, i.e. the real
    # season-average win probability. Was a hardcoded 1/3 (an even
    # win/draw/loss split); confirmed live that the real measured average
    # is 0.380 for the EPL (760 fixture-sides) because the real draw rate
    # is ~24%, not ~33% - the hardcoded constant baked a ~14% systematic
    # inflation into every attack/pressure-mode stat, for every fixture.
    # The "auto" sentinel (not the resolved number) is what's hashed into
    # this dict via get_or_create_algorithm_version, so day-to-day odds
    # movement doesn't mint a new algorithm revision on its own.
    "neutral_attack": "auto",
    "neutral_clean_sheet": DEFAULT_WEIGHTS["neutral_clean_sheet"],
    "shrinkage_games": DEFAULT_WEIGHTS["shrinkage_games"],
    # Used for appearance_rate = PT1 / season_games in
    # compute_involvement_rates() - how many of a season's fixtures a
    # position-average player features in at all.
    "season_games": 38,
    # Neither the projected-stat set nor the involvement formula below is
    # otherwise represented in this dict - bumping either of these two
    # keys forces get_or_create_algorithm_version to mint a new revision
    # instead of silently reusing the last one when only the surrounding
    # Python code (not a literal weight) changes.
    "stat_set": sorted(STAT_COLUMNS.keys()),
    "involvement_model": "pt1_pt60_pt90_v1",
}

# Guessed raw-string -> multiplier mapping for FanTeam's pre-match status
# fields (`lineup`/`status` on each playerChoices record - see
# scraper_fanteam.py / import_fanteam_live.py / migration 0027). ONLY
# "expected" (lineup) and "not_started" (status) have been observed live
# as of 2026-07-19, ~5 weeks before kickoff - every other key below is a
# best-guess mapping to FanTeam's own STA/BEN/NOT/EXP/MAY/NES/INJ/SUS/
# N-A/OFF badge scheme (from a user screenshot), NOT yet confirmed
# against real variance. Any value not listed here (including both
# values seen live today) intentionally falls through to 1.0 - fail open,
# so a wrong or missing guess never wrongly zeroes a score. Run
# scripts/verify_player_status_mapping.py once real variance shows up
# (close to matchday) to confirm/correct these before fully trusting
# them - see that script's own docstring, and KNOWN LIMITATIONS above.
#
# To retune: just edit the numbers below - each key is independent, no
# other code needs to change.
LINEUP_MULTIPLIERS = {
    "confirmed_starting": 1.0,       # STA - confirmed starter, safest/highest
    "expected": 0.95,                # EXP - expected but not yet confirmed (today's only observed value)
    "might_start": 0.75,             # MAY - light discount
    "not_expected": 0.35,            # NES - heavier discount, usually bench
    "confirmed_benched": 0.1,        # BEN - confirmed not starting
    "confirmed_not_in_squad": 0.0,   # NOT - confirmed out of the squad entirely
}
STATUS_MULTIPLIERS = {
    "injured": 0.0,        # INJ
    "suspended": 0.0,      # SUS
    "not_available": 0.0,  # N/A
    "gameweek_off": 0.0,   # OFF
    # "not_started" (today's only observed value) is deliberately absent -
    # unknown whether it even signals availability vs. an unrelated live
    # match-progress flag (paired with minutes/points/totalPoints/form,
    # all 0 pre-kickoff for an unrelated reason - see KNOWN LIMITATIONS
    # above). Falls through to 1.0 either way, which is safe under both
    # interpretations.
}
DEFAULT_STATUS_MULTIPLIER = 1.0


def status_multiplier(lineup, status):
    """Combined discount for one player's captured pre-match status.
    Missing/unrecognized lineup or status independently no-op at 1.0."""
    m = LINEUP_MULTIPLIERS.get(lineup, DEFAULT_STATUS_MULTIPLIER)
    m *= STATUS_MULTIPLIERS.get(status, DEFAULT_STATUS_MULTIPLIER)
    return m


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


def get_or_create_algorithm_version(cur, family, description, weights):
    """
    Real versioning (see migration 0032 - this replaced an upsert-on-label
    that silently overwrote weights in place). `family` groups revisions
    of "the same algorithm" (e.g. "v2-decomposed"); if `weights` matches
    the family's current (highest-revision) row exactly, that row is
    reused - no new row for an unrelated description edit or a re-run
    with identical weights. If `weights` differs at all, a new revision
    is created and version_label becomes "family.revision" - so every
    genuine tuning change gets its own permanent row, which the Mary
    Performance Lab needs to compare prediction accuracy across algorithm
    changes.
    """
    cur.execute(
        "select id, revision, weights from algorithm_versions where family = %s order by revision desc limit 1",
        (family,),
    )
    row = cur.fetchone()

    if row is not None:
        existing_id, existing_revision, existing_weights = row
        if isinstance(existing_weights, str):
            existing_weights = json.loads(existing_weights)
        if existing_weights == weights:
            cur.execute("update algorithm_versions set description = %s where id = %s", (description, existing_id))
            return existing_id, weights
        next_revision = existing_revision + 1
    else:
        next_revision = 1

    version_label = f"{family}.{next_revision}"
    cur.execute(
        """
        insert into algorithm_versions (version_label, family, revision, description, weights)
        values (%s, %s, %s, %s, %s)
        returning id, weights
        """,
        (version_label, family, next_revision, description, psycopg2.extras.Json(weights)),
    )
    return cur.fetchone()


def resolve_neutral_attack(cur, game_id, weights):
    """Resolves the "auto" sentinel in DEFAULT_WEIGHTS_V2's neutral_attack
    to the real, live season-average attack_score for this game - see the
    comment on DEFAULT_WEIGHTS_V2 for why this is computed at runtime
    rather than stored as a fixed number. Passes through unchanged for v1
    (DEFAULT_WEIGHTS' neutral_attack is still a literal 1/3 - out of scope
    for this pass, see docstring)."""
    if weights["neutral_attack"] != "auto":
        return float(weights["neutral_attack"])
    cur.execute("select avg(attack_score) from team_fixture_difficulty where game_id = %s", (game_id,))
    return float(cur.fetchone()[0])


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


def fetch_player_status(cur, game_id, gameweek):
    """{game_player_id: (lineup, status)} for one gameweek - empty dict if
    gameweek is None (period-mode, e.g. Dream Team, which has no live
    status source at all) or nothing captured yet - the natural no-op
    default that leaves every score unmultiplied."""
    if gameweek is None:
        return {}
    cur.execute(
        """
        select gp.id, s.lineup, s.status
        from fanteam_player_status s
        join game_players gp on gp.id = s.game_player_id
        where gp.game_id = %s and s.gameweek = %s
        """,
        (game_id, gameweek),
    )
    return {row[0]: (row[1], row[2]) for row in cur.fetchall()}


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
        # minutes_played <= 0 (not just "row missing") - every active
        # player now has a row (see main()'s left join), including
        # zero-history ones (newly promoted squads, fresh signings) whose
        # all-zero stats must NOT count toward the cohort this shrinkage
        # prior is drawn from, same as when they were absent entirely.
        if not row or row["minutes_played"] <= 0:
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


def compute_involvement_rates(players, historical_rows, season_games):
    """
    players: [(game_player_id, position, player_id)]
    historical_rows: {player_id: {..., pt1, pt60, pt90}}
    Returns {pos: {"appearance": x, "cond60": x, "cond90": x, "avg_minutes_per_appearance": x}} -
    unshrunk position averages used as the shrinkage prior for each
    player's own appearance/cond60/cond90 rate in project_player_stats,
    same technique as compute_shrunk_rates above but in "games" units, not
    per-90 units:
      appearance = PT1 / season_games   (P(features at all) in a fixture)
      cond60     = PT60 / PT1           (P(60+ min | featured), PT1-weighted)
      cond90     = PT90 / PT1           (P(full 90 | featured), PT1-weighted)
    avg_minutes_per_appearance is the position's own minutes/PT1 -
    project_player_stats falls back to this for a player with zero
    historical PT1 (a real appearance-per-90 average, not a guess) instead
    of computing 0 minutes played / 0 appearances.
    """
    totals = {pos: {"pt1": 0.0, "pt60": 0.0, "pt90": 0.0, "minutes": 0.0, "players": 0} for pos in POSITIONS}
    for _, position, player_id in players:
        row = historical_rows.get(player_id)
        # Same "minutes_played <= 0 excludes, not just a missing row"
        # reasoning as compute_shrunk_rates above - critically also keeps
        # totals["players"] (the appearance-rate denominator) from being
        # inflated by zero-signal players, which would silently shrink
        # the whole position's appearance rate downward.
        if not row or row["minutes_played"] <= 0:
            continue
        t = totals[position]
        t["pt1"] += row["pt1"]
        t["pt60"] += row["pt60"]
        t["pt90"] += row["pt90"]
        t["minutes"] += row["minutes_played"]
        t["players"] += 1
    return {
        pos: {
            "appearance": (totals[pos]["pt1"] / (totals[pos]["players"] * season_games)) if totals[pos]["players"] else 0.0,
            "cond60": (totals[pos]["pt60"] / totals[pos]["pt1"]) if totals[pos]["pt1"] else 0.0,
            "cond90": (totals[pos]["pt90"] / totals[pos]["pt1"]) if totals[pos]["pt1"] else 0.0,
            # 70.0 fallback only fires if literally every player at this
            # position has zero historical minutes - shouldn't happen in
            # practice but avoids a div/0 in the (impossible in normal
            # data) all-new-position case.
            "avg_minutes_per_appearance": (totals[pos]["minutes"] / totals[pos]["pt1"]) if totals[pos]["pt1"] else 70.0,
        }
        for pos in POSITIONS
    }


def project_player_stats(position, historical_row, fixture, weights, position_avg, position_involvement):
    """Per-stat projected count for one player's one fixture (v2-decomposed).
    Returns (projected, expected_minutes_fraction) - the fraction is also
    exposed as predicted_minutes on each fixture_breakdown entry in main(),
    for the Hail Mary Form System (player_gameweek_predictions, migration
    0044) to freeze - it was previously computed here and discarded."""
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

    # Involvement: three separately-shrunk probabilities derived from last
    # season's PT1/PT60/PT90 (games featured / games with 60+ minutes /
    # games with a full 90), instead of one linear minutes/90/season_games
    # number copied across all three stats below - see
    # compute_involvement_rates(). pt1 is floored to 1 defensively (never
    # 0 in live data when minutes_played > 0, but avoids a div/0 if that
    # ever changes).
    raw_pt1 = historical_row["pt1"]
    pt1 = max(raw_pt1, 1.0)
    pt60 = historical_row["pt60"]
    pt90 = historical_row["pt90"]
    pos_inv = position_involvement[position]

    appearance_rate = (pt1 + k * pos_inv["appearance"]) / (season_games + k)
    cond60_rate = (pt60 + k * pos_inv["cond60"]) / (pt1 + k)
    cond90_rate = (pt90 + k * pos_inv["cond90"]) / (pt1 + k)
    # A player with zero historical appearances (raw_pt1 == 0 - a newly
    # promoted team's whole squad, most transfer-window signings, ...)
    # has no personal minutes/appearance ratio to compute - historical_row
    # ["minutes_played"] is 0 too, so 0/pt1_floored would silently project
    # 0 expected minutes regardless of how confident appearance_rate is.
    # Falls back to the position's own average instead, same shrink-to-
    # cohort philosophy as every other stat here.
    if raw_pt1 > 0:
        avg_minutes_per_appearance = historical_row["minutes_played"] / raw_pt1
    else:
        avg_minutes_per_appearance = pos_inv["avg_minutes_per_appearance"]
    expected_minutes_fraction = min(1.0, appearance_rate * avg_minutes_per_appearance / 90.0)

    projected = {
        "appearance": appearance_rate,
        "minutes_60_plus": appearance_rate * cond60_rate,
        "played_full_match": appearance_rate * cond90_rate,
    }
    for stat, col in STAT_COLUMNS.items():
        raw_rate = (historical_row[col] + k * position_avg[position][col]) / (games90 + k)
        factor = factor_by_mode[STAT_FIXTURE_MODE[stat]]
        rate_scale = STAT_RATE_SCALE.get(stat, 1.0)
        projected[stat] = raw_rate * factor * expected_minutes_fraction * rate_scale
    return projected, expected_minutes_fraction


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
                "per-stat projection (goals/assists/clean sheets/cards/saves/shots on target/own goals/"
                "penalty saves) priced through game_scoring_rules, PT1/60/90-based involvement, "
                "self-calibrating neutral_attack",
                DEFAULT_WEIGHTS_V2,
            )
        else:
            algo_id, weights = get_or_create_algorithm_version(
                cur, "v1", "points_per_90 x position-weighted fixture factor", DEFAULT_WEIGHTS
            )
        if isinstance(weights, str):
            weights = json.loads(weights)

        # Players + last season's historical totals. RealDictCursor so
        # adding columns (shots_on_target/own_goals/penalty_saves/pt1/
        # pt60/pt90, pulled from raw_stats) can't silently misalign the
        # positional tuple-index unpacking a plain cursor would need.
        dict_cur = conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor)
        dict_cur.execute(
            """
            select gp.id as game_player_id, p.position, gp.player_id, p.full_name,
                   coalesce(gps.total_points, 0) as total_points, coalesce(gps.minutes_played, 0) as minutes_played,
                   coalesce(gps.goals, 0) as goals, coalesce(gps.assists, 0) as assists,
                   coalesce(gps.clean_sheets, 0) as clean_sheets, coalesce(gps.saves, 0) as saves,
                   coalesce(gps.goals_conceded, 0) as goals_conceded, coalesce(gps.yellow_cards, 0) as yellow_cards,
                   coalesce(gps.red_cards, 0) as red_cards,
                   coalesce((gps.raw_stats->>'SOT')::numeric, 0) as shots_on_target,
                   coalesce((gps.raw_stats->>'ownGoals')::numeric, 0) as own_goals,
                   coalesce((gps.raw_stats->>'penaltySaves')::numeric, 0) as penalty_saves,
                   coalesce((gps.raw_stats->>'PT1')::numeric, 0) as pt1,
                   coalesce((gps.raw_stats->>'PT60')::numeric, 0) as pt60,
                   coalesce((gps.raw_stats->>'PT90')::numeric, 0) as pt90
            from game_players gp
            join players p on p.id = gp.player_id
            left join game_player_stats gps
                on gps.game_player_id = gp.id and gps.season = %s and gps.gameweek = 0
            where gp.game_id = %s and gp.is_active = true
            """,
            (HISTORICAL_SEASON, game_id),
        )
        raw_players = dict_cur.fetchall()
        dict_cur.close()
        players = [(r["game_player_id"], r["position"], r["player_id"]) for r in raw_players]
        full_name_by_game_player_id = {r["game_player_id"]: r["full_name"] for r in raw_players}
        historical_by_player_id = {
            r["player_id"]: {
                "total_points": float(r["total_points"]), "minutes_played": r["minutes_played"],
                "goals": r["goals"], "assists": r["assists"], "clean_sheets": r["clean_sheets"], "saves": r["saves"],
                "goals_conceded": r["goals_conceded"], "yellow_cards": r["yellow_cards"], "red_cards": r["red_cards"],
                "shots_on_target": float(r["shots_on_target"]), "own_goals": float(r["own_goals"]),
                "penalty_saves": float(r["penalty_saves"]),
                # Deliberately NOT floored here (unlike the old behavior) -
                # a genuinely-0 pt1 (no historical minutes at all, e.g. a
                # newly-promoted team's whole squad, who FanTeam's own
                # query used to silently exclude via an inner join) needs
                # to stay distinguishable from "had 1 real appearance" so
                # project_player_stats can fall back to a position-average
                # minutes-per-appearance instead of dividing 0/1 -> 0
                # minutes. The safety floor still applies locally in
                # project_player_stats for the rate formulas themselves.
                "pt1": float(r["pt1"]), "pt60": float(r["pt60"]), "pt90": float(r["pt90"]),
            }
            for r in raw_players
        }
        game_player_meta = {r["game_player_id"]: (r["position"], r["player_id"]) for r in raw_players}

        # Position-average points-per-90 (v1) and per-stat position averages (v2),
        # weighted by minutes - not a plain average of individual rates, same
        # small-sample reasoning as the shrinkage above.
        position_totals = {}
        for r in raw_players:
            agg = position_totals.setdefault(r["position"], [0.0, 0.0])
            agg[0] += float(r["total_points"])
            agg[1] += float(r["minutes_played"]) / 90.0
        # games==0 for a whole position is now reachable (the left join
        # above includes zero-history players instead of excluding them -
        # a position where literally everyone is zero-history, e.g. a
        # squad's entire allocation at a position turning over, previously
        # just never appeared in raw_players at all under the old inner
        # join, masking this). Same 0.0-fallback shape as compute_shrunk_
        # rates' own position_avg dict just below.
        position_avg_pp90 = {pos: (pts / games if games > 0 else 0.0) for pos, (pts, games) in position_totals.items()}
        position_avg_rates = compute_shrunk_rates(players, historical_by_player_id)
        # Only meaningful for v2 (weights["season_games"] doesn't exist on
        # v1's DEFAULT_WEIGHTS) - v1 never calls project_player_stats.
        position_involvement = (
            compute_involvement_rates(players, historical_by_player_id, weights["season_games"]) if use_v2 else None
        )

        # neutral_attack resolved once here (not per-player below) so this
        # doesn't cost an extra query per player - see resolve_neutral_attack().
        runtime_weights = {**weights, "neutral_attack": resolve_neutral_attack(cur, game_id, weights)} if use_v2 else weights

        if gameweek is not None:
            rows = fetch_fixtures_by_gameweek(cur, game_id, gameweek)
        else:
            rows = fetch_fixtures_by_period(cur, game_id, period_start, period_end)

        player_status = fetch_player_status(cur, game_id, gameweek)

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
                neutral_fixture = {
                    "attack_score": runtime_weights["neutral_attack"],
                    "clean_sheet_score": runtime_weights["neutral_clean_sheet"],
                }
                neutral_stats, _ = project_player_stats(
                    position, historical_row, neutral_fixture, runtime_weights, position_avg_rates, position_involvement
                )
                points_per_90, _ = price_projected_stats(position, neutral_stats, scoring_rules)

                score = 0.0
                fixture_breakdown = []
                for fx in player_fixtures:
                    projected_stats, expected_minutes_fraction = project_player_stats(
                        position, historical_row, fx, runtime_weights, position_avg_rates, position_involvement
                    )
                    contribution, priced = price_projected_stats(position, projected_stats, scoring_rules)
                    score += contribution
                    fixture_factor_equiv = contribution / points_per_90 if points_per_90 > 0 else 0.0
                    fixture_breakdown.append({
                        "fixture_id": fx["fixture_id"], "kickoff_at": fx["kickoff_at"],
                        "attack_score": fx["attack_score"], "clean_sheet_score": fx["clean_sheet_score"],
                        "fixture_factor": round(fixture_factor_equiv, 3),
                        "contribution": round(contribution, 3), "stats": priced,
                        # For the Hail Mary Form System (player_gameweek_predictions) -
                        # a double gameweek only reflects fixtures[0] here, same
                        # single-fixture caveat as the probability fields below;
                        # hail_mary_score itself still correctly sums both fixtures.
                        "predicted_minutes": round(expected_minutes_fraction * 90, 1),
                    })
                inputs = {
                    "points_per_90": round(points_per_90, 3),
                    "neutral_attack_used": round(runtime_weights["neutral_attack"], 4),
                    # Sample-size signal for the Hail Mary Form System's
                    # confidence formula (scripts/capture_gameweek_predictions.py) -
                    # how many 90-minute games of real history this player's
                    # shrunk rates are actually based on.
                    "games90": round(historical_row["minutes_played"] / 90.0, 2),
                    "fixtures": fixture_breakdown,
                }
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
                inputs = {
                    "points_per_90": round(points_per_90, 3),
                    "games90": round(games_played, 2),
                    "fixtures": fixture_breakdown,
                }

            lineup, status = player_status.get(game_player_id, (None, None))
            multiplier = status_multiplier(lineup, status)
            if multiplier != 1.0:
                score *= multiplier
            inputs["status"] = {"lineup": lineup, "status": status, "multiplier": multiplier}

            # activity_log: only for real gameweek-anchored recomputes -
            # period-mode (Dream Team) isn't part of the automated
            # pipeline anyway (no live scrape source yet). Same 0.5
            # threshold as frontend/src/lib/watchlistAlerts.ts's
            # SCORE_INCREASE_THRESHOLD, kept numerically consistent
            # rather than inventing a second number.
            if gameweek is not None:
                cur.execute(
                    "select hail_mary_score from projections where algorithm_version_id = %s and game_player_id = %s and gameweek = %s",
                    (algo_id, game_player_id, gameweek),
                )
                prev_row = cur.fetchone()
                if prev_row is not None:
                    old_score = float(prev_row[0])
                    if abs(score - old_score) >= 0.5:
                        name = full_name_by_game_player_id.get(game_player_id, "A player")
                        direction = "rose" if score > old_score else "fell"
                        log_event(
                            cur,
                            "score_changed",
                            f"{name}'s Hail Mary Score {direction} from {old_score:.1f} to {score:.1f} (GW{gameweek})",
                            game_id=game_id,
                            game_player_id=game_player_id,
                            details={"gameweek": gameweek, "old_score": round(old_score, 3), "new_score": round(score, 3)},
                        )

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
