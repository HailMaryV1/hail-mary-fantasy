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
import math
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
    # Dream Team-only stats (migration 0053) - raw-only, no typed column,
    # same pattern as shot_on_target/own_goal/penalty_save above. Harmless
    # no-ops for FanTeam: no matching game_scoring_rules row for fanteam
    # means these always contribute 0 there (see price_projected_stats).
    "big_chance_created": "big_chance_created",
    "tackle": "tackle",
    "penalty_miss": "penalty_miss",
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
    "big_chance_created": "attack",  # same driver as goal/assist/shot_on_target
    "tackle": "pressure",  # more defensive workload against stronger attacks, same bucket as save
    "penalty_miss": "flat",  # rare event, no fixture signal predicts it - same treatment as cards
}
# goals_conceded_per_2's point value in the matrix is "per 2 conceded" -
# our projected rate is per single goal, so halve it before pricing.
# tackle/save don't need this: Dream Team's own "1 point per 2" rule for
# those is entered directly as the per-unit-equivalent point value (0.5)
# in migration 0053, matching FanTeam's own existing 'save' convention.
STAT_RATE_SCALE = {"goals_conceded_per_2": 0.5}

# Dream Team's CSV uses different raw_stats key names than FanTeam's for
# some of the same stats (shotsOnTarget vs SOT), plus a whole set of stats
# FanTeam's export doesn't have at all - the 12 Bonus Points PPM
# components (Section 3.2.4.4 of Dream Team's rules) and the extra Player
# Points stats (big chance created, tackles, penalty misses). Resolved
# here in Python, keyed by game slug, rather than more hardcoded SQL ->>
# extracts - keeps the existing FanTeam SQL columns in main() untouched
# (zero regression risk to FanTeam), while making Dream Team's differently
# -named keys resolvable. A game slug with no entry here (FanTeam) simply
# gets an empty alias set, so every key below defaults to 0 for it - safe,
# since FanTeam's own game_scoring_rules has no rows for any of these
# stats and compute_bonus_points is only meaningful where PPM data exists.
RAW_STAT_ALIASES = {
    "dreamteam": {
        "shots_on_target": "shotsOnTarget",
        "big_chance_created": "chancesCreated",
        "tackle": "tackles",
        "penalty_miss": "penaltyMisses",
        # Bonus Points PPM components - not priced through
        # game_scoring_rules at all, see compute_bonus_points().
        "ppm_dribble": "dribbles",
        "ppm_cross": "crosses",
        "ppm_offside": "offsides",
        "ppm_pass_completion_rate": "passCompletionRate",
        "ppm_interception": "interceptions",
        "ppm_block": "blocks",
        "ppm_goal_outside_area": "goalsOutsideArea",
        "ppm_foul_won": "foulsWon",
        "ppm_foul_conceded": "foulsMade",
        "ppm_error_leading_to_goal": "errorsLeadingToGoal",
        "ppm_claim": "claims",
        "ppm_punch": "punches",
        "ppm_keeper_sweep": "keeperSweeps",
    },
}

# Bonus Points (Dream Team Section 3.2.4.3/3.2.4.4) - NOT a per-stat
# game_scoring_rules row like everything else in this file, because it's a
# two-stage DERIVED value: 12 raw per-match event rates get weighted-summed
# into a single "PPM" (Player Performance Marks) score, which then passes
# through a tiered step function to become bonus points. No flat "rate x
# points" shape can represent a step function - see compute_bonus_points().
PPM_WEIGHTS = {
    "ppm_dribble": 1,
    "ppm_cross": 1,
    "ppm_offside": -1,
    "ppm_interception": 1,
    "ppm_block": 1,
    "ppm_goal_outside_area": 1,
    "ppm_foul_won": 1,
    "ppm_foul_conceded": -1,
    "ppm_error_leading_to_goal": -2,
}
PPM_GK_WEIGHTS = {
    "ppm_claim": 1,
    "ppm_punch": 1,
    "ppm_keeper_sweep": 1,
}
# All count-based PPM components, shrunk toward the position average the
# same per-90-rate way as every other STAT_COLUMNS stat (see
# compute_shrunk_rates, which folds this list in). Pass completion rate is
# handled separately below - it's a season-average PERCENTAGE, not a
# per-match count, so summing/dividing by games90 the same way would not
# reproduce a sensible average.
PPM_COMPONENT_COLUMNS = list(PPM_WEIGHTS) + list(PPM_GK_WEIGHTS)


def pass_completion_ppm(rate_pct):
    """Section 3.2.4.4's pass-completion PPM tier, applied to a player's
    season-average pass completion rate every match - the real rule's
    "minimum 25 passes attempted" per-match qualifier can't be verified
    from a season aggregate (we only have the average, not per-match pass
    counts), a documented simplification."""
    if rate_pct >= 90:
        return 3
    if rate_pct >= 80:
        return 2
    if rate_pct >= 70:
        return 1
    return 0


def bonus_tier(ppm):
    """Section 3.2.4.3's Bonus Points tier - a step function over expected
    PPM for one match."""
    if ppm >= 12:
        return 5
    if ppm >= 8:
        return 3
    if ppm >= 5:
        return 1
    return 0


def compute_pass_completion_position_avg(players, historical_rows):
    """Minutes-weighted average pass-completion percentage per position -
    the shrinkage prior for compute_bonus_points' pass-completion PPM
    component. Not a per-90 rate like compute_shrunk_rates' other stats (a
    percentage isn't additive across appearances the way a raw count is,
    so it's weighted by minutes instead of summed and divided by games90)."""
    totals = {pos: [0.0, 0.0] for pos in POSITIONS}  # [minutes-weighted sum, minutes]
    for _, position, player_id in players:
        row = historical_rows.get(player_id)
        if not row or row["minutes_played"] <= 0:
            continue
        totals[position][0] += row.get("ppm_pass_completion_rate", 0.0) * row["minutes_played"]
        totals[position][1] += row["minutes_played"]
    return {pos: (totals[pos][0] / totals[pos][1] if totals[pos][1] > 0 else 0.0) for pos in POSITIONS}


def compute_bonus_points(position, historical_row, position_avg, pass_completion_position_avg, weights, expected_minutes_fraction):
    """Expected Dream Team bonus points for one fixture.

    All 12 PPM components are treated as fixture-flat here (no attack/
    pressure adjustment) - a deliberate v1 simplification, the same
    treatment cards already get elsewhere in this file (STAT_FIXTURE_MODE
    "flat"). Fixture-adjusting 12 granular micro-stats individually would
    add real guesswork with nothing yet to validate it against.

    Averaging each component's rate and THEN applying bonus_tier's step
    function is a slight underestimate of true expected bonus for a
    player who straddles a tier boundary (Jensen's-inequality gap on a
    concave step function) - a known, documented v1 limitation. Refinable
    later via a distributional/Monte Carlo approach (already proven for
    golf's scoring simulation) once real Dream Team gameweek results exist
    to check this deterministic version against, via the same
    algorithm-performance grading pattern already built for golf/FanTeam.
    """
    k = weights["shrinkage_games"]
    games90 = historical_row["minutes_played"] / 90.0
    pos_avg = position_avg[position]

    def shrunk_rate(col):
        return (historical_row.get(col, 0.0) + k * pos_avg.get(col, 0.0)) / (games90 + k)

    ppm = 0.0
    for stat, point_weight in PPM_WEIGHTS.items():
        ppm += shrunk_rate(stat) * point_weight
    if position == "GK":
        for stat, point_weight in PPM_GK_WEIGHTS.items():
            ppm += shrunk_rate(stat) * point_weight

    raw_pass_rate = historical_row.get("ppm_pass_completion_rate", 0.0)
    shrunk_pass_rate = (raw_pass_rate * games90 + k * pass_completion_position_avg[position]) / (games90 + k)
    ppm += pass_completion_ppm(shrunk_pass_rate)

    ppm *= expected_minutes_fraction
    return bonus_tier(ppm)

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
    # Same "force a new revision on any code-shape change" purpose as the
    # two keys above - bonus points (Dream Team only) and the minutes-based
    # involvement fallback (games with no real PT1/PT60/PT90 data) are both
    # new mechanisms, not literal tunable numbers.
    "bonus_model": "ppm_tier_v1",
    "involvement_fallback": "minutes_proxy_v1",
    # Forces a new algorithm_versions revision the first time the modular
    # goal/assist/clean-sheet blending (historical/fixture-model/bookmaker,
    # see MODULAR_STATS below) runs, even if module weight VALUES happen
    # to coincide with whatever the pre-modular single-formula version
    # last computed with - same purpose as the keys above.
    "module_engine_version": "v2",
    # Forces a new algorithm_versions revision the moment the Opportunity
    # Model (Phase A) actually goes live - expected_minutes_fraction (and,
    # with it, the "appearance"/"minutes_60_plus"/"played_full_match"
    # scoring stats - see compute_opportunity()) now comes from the
    # decomposed P(start) model instead of the single blended appearance_
    # rate x avg_minutes_per_appearance formula it replaces, even though
    # no literal weight value below changed.
    "opportunity_model_version": "v1",
}

# The 3 stats with both a real fixture-level driver AND a real bookmaker
# market to draw from (goal: SportMonks anytime-goalscorer; assist:
# SportMonks "Player to Assist" (added 2026-07-30) - both via the
# Bookmaker Intelligence Hub; clean_sheet_60min: real match-winner odds
# directly). Every other STAT_COLUMNS entry keeps the exact single-formula
# treatment it always had (historical rate x the coalesced fixture
# factor) - modularizing a stat with no genuinely independent extra
# signal would just add complexity with nothing new to blend in. Whether
# the assist market is actually offered for Premier League fixtures
# specifically is still unconfirmed as of this build (no PL fixture has
# been close enough to kickoff to test) - see compute_module_rate_bookmaker,
# which correctly returns None until real (or baseline-scaled) data
# exists, so its configured weight simply redistributes to the other two
# in the meantime, exactly as it always has.
MODULAR_STATS = {"goal", "assist", "clean_sheet_60min"}

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


# Selected once by every fixture query below, alongside the existing
# coalesced tfd.attack_score/clean_sheet_score (kept for every non-modular
# stat, unchanged) - the REAL-odds-only and model-only components split
# apart, so the modular stats' Bookmaker Intelligence and Fixture Model
# modules each read from exactly one source and can never see the same
# raw probability the other one used (see stat_factor_from_scores,
# compute_module_rate_historical/fixture_model/bookmaker below).
FIXTURE_PROBABILITY_JOIN_SQL = """
        join fixtures f on f.id = tfd.fixture_id
        left join lateral (
            select home_win_prob, draw_prob, away_win_prob from fixture_probabilities
            where fixture_id = tfd.fixture_id order by computed_at desc limit 1
        ) real_prob on true
        left join lateral (
            select home_win_prob, draw_prob, away_win_prob from fixture_strength_model_probabilities
            where fixture_id = tfd.fixture_id order by computed_at desc limit 1
        ) model_prob on true
"""
FIXTURE_PROBABILITY_SELECT_SQL = """
               p.id as player_id, p.team_id, tfd.fixture_id, tfd.kickoff_at,
               tfd.attack_score, tfd.clean_sheet_score,
               f.home_team_id, f.away_team_id,
               real_prob.home_win_prob as real_home_win_prob, real_prob.draw_prob as real_draw_prob,
               real_prob.away_win_prob as real_away_win_prob,
               model_prob.home_win_prob as model_home_win_prob, model_prob.draw_prob as model_draw_prob,
               model_prob.away_win_prob as model_away_win_prob
"""


def fetch_fixtures_by_period(cur, game_id, period_start, period_end):
    cur.execute(
        f"""
        select {FIXTURE_PROBABILITY_SELECT_SQL}
        from players p
        join team_fixture_difficulty tfd
            on tfd.team_id = p.team_id and tfd.game_id = %s
        {FIXTURE_PROBABILITY_JOIN_SQL}
        where tfd.kickoff_at >= %s and tfd.kickoff_at < %s
        """,
        (game_id, period_start, period_end),
    )
    return cur.fetchall()


def fetch_fixtures_by_gameweek(cur, game_id, gameweek):
    cur.execute(
        f"""
        select {FIXTURE_PROBABILITY_SELECT_SQL}
        from players p
        join team_fixture_difficulty tfd
            on tfd.team_id = p.team_id and tfd.game_id = %s
        {FIXTURE_PROBABILITY_JOIN_SQL}
        join game_fixture_gameweeks gfg
            on gfg.fixture_id = tfd.fixture_id and gfg.game_id = tfd.game_id and gfg.gameweek = %s
        """,
        (game_id, gameweek),
    )
    return cur.fetchall()


def _team_side_win_draw(home_win_prob, draw_prob, away_win_prob, team_id, home_team_id):
    """None if this source (real odds or the strength model) has no row
    at all for this fixture - a genuinely absent signal, not a 0."""
    if home_win_prob is None:
        return None, None
    win_prob = float(home_win_prob) if team_id == home_team_id else float(away_win_prob)
    return win_prob, float(draw_prob) if draw_prob is not None else 0.0


def _attack_and_clean_sheet(win_prob, draw_prob):
    if win_prob is None:
        return None, None
    return win_prob, win_prob + 0.5 * draw_prob


def stat_factor_from_scores(stat, attack_score, clean_sheet_score, weights):
    """The attack/clean_sheet/pressure/flat fixture adjustment for one
    stat, given EXPLICIT attack/clean-sheet numbers rather than reading
    them off a fixture dict - callers choose which source (the legacy
    coalesced team_fixture_difficulty values for non-modular stats, the
    real-odds-only figures for Bookmaker Intelligence, or the model-only
    figures for Fixture Model/Historical Performance) to pass in, so this
    one formula serves all of them without the attack/pressure/
    clean_sheet math being duplicated per source. None in, None out - a
    missing source produces no factor, never a fabricated neutral one."""
    if attack_score is None or clean_sheet_score is None:
        return None
    neutral_attack = weights["neutral_attack"]
    neutral_clean_sheet = weights["neutral_clean_sheet"]
    mode = STAT_FIXTURE_MODE[stat]
    if mode == "attack":
        return attack_score / neutral_attack
    if mode == "clean_sheet":
        return clean_sheet_score / neutral_clean_sheet
    if mode == "pressure":
        return (1 - clean_sheet_score) / (1 - neutral_clean_sheet)
    return 1.0


def fixture_stat_factor(stat, fixture, weights):
    """The existing (coalesced, real-odds-or-strength-model) fixture
    factor - unchanged behaviour, used by every non-modular stat exactly
    as before this file gained a modular engine."""
    return stat_factor_from_scores(stat, float(fixture["attack_score"]), float(fixture["clean_sheet_score"]), weights)


def anytime_prob_to_expected_goals(p):
    """Converts a real P(scores >= 1 goal) market probability to E[goals],
    assuming goals in a match follow a Poisson distribution: P(0 goals) =
    e^-lambda, so lambda = -ln(1 - p). A standard, well-established
    conversion, not a guess - without it, a striker's multi-goal
    probability would be silently ignored and E[goals] systematically
    understated relative to treating the anytime-goalscorer price as if
    it were already an expected-goals figure."""
    p = max(0.0, min(0.99, p))
    return -math.log(1 - p) if p > 0 else 0.0


def historical_shrunk_rate(stat, historical_row, position, position_avg, weights):
    """This player's own shrunk per-90 rate for `stat` - fixture-neutral,
    no factor applied. Extracted from compute_module_rate_historical (its
    raw_rate line, unchanged) so Recent Form's shrinkage prior (see
    compute_recent_form_stat) and Historical Performance's own blended
    rate both read from exactly one shared calculation - never from each
    other's output, and never from the post-blend modular rate (which,
    for Recent Form's purposes, would already include Recent Form's own
    contribution - a real circularity, not a hypothetical one).

    Always defined: every player has a historical_row (all-zero for a
    zero-history one), and k-shrinkage already folds toward
    position_avg[position][stat] as games90 -> 0 - the same single
    formula IS both "step 1: player's own rate" and "step 2: position
    prior" in the fallback sense (see compute_recent_form_stat's
    docstring) - not two separate branches."""
    k = weights["shrinkage_games"]
    col = STAT_COLUMNS[stat]
    games90 = historical_row["minutes_played"] / 90.0
    return (historical_row[col] + k * position_avg[position][col]) / (games90 + k)


def compute_module_rate_historical(stat, historical_row, position, position_avg, fixture, weights):
    """This player's own shrunk per-90 rate (historical_shrunk_rate) x our
    own team-strength MODEL's fixture factor (fixture_strength_model_probabilities,
    migration 0017) - deliberately never the real-odds figure, even when
    one exists for this fixture, so real market data enters the blend
    through exactly one module (Bookmaker Intelligence) and never through
    this one too. Always available (every player has a historical row,
    all-zero for zero-history ones) - falls back to a neutral 1.0 factor
    only in the (shouldn't-happen) case the model has no row at all for
    this fixture, since this module must never simply go missing."""
    factor = stat_factor_from_scores(stat, fixture.get("model_attack_score"), fixture.get("model_clean_sheet_score"), weights)
    if factor is None:
        factor = 1.0
    return historical_shrunk_rate(stat, historical_row, position, position_avg, weights) * factor


def compute_module_rate_fixture_model(stat, position, position_avg, fixture, weights):
    """The POSITION's own average historical rate x the same team-strength
    MODEL fixture factor as compute_module_rate_historical (never real
    odds) - "what would a league-average player in this slot be expected
    to do in this exact matchup, by our own model's view of it,"
    independent of this specific player's own track record. None if the
    model genuinely has no row for this fixture yet."""
    factor = stat_factor_from_scores(stat, fixture.get("model_attack_score"), fixture.get("model_clean_sheet_score"), weights)
    if factor is None:
        return None
    col = STAT_COLUMNS[stat]
    return position_avg[position][col] * factor


def compute_module_rate_bookmaker(stat, fixture, player_id, hub_features):
    """Real market-derived signal ONLY - never the season-strength
    fallback (that's Historical Performance's and Fixture Model's job
    above), so the same raw number can never enter the blend twice.
    clean_sheet_60min uses this fixture's REAL win/draw odds directly
    (fixture_probabilities) - None if no real odds exist yet for this
    fixture. goal/assist use the Bookmaker Intelligence Hub's
    score_probability/assist_probability (bookmaker_player_features,
    migration 0064 - real observation or a baseline scaled from one, see
    scripts/import_sportmonks_player_props.py) converted from P(event
    >= 1) to E[event] via the same Poisson-implied conversion for both -
    the math isn't goal-specific, just P(count >= 1) -> lambda. Every
    other stat returns None - no cards/saves market is ingested into the
    hub yet, so its configured weight simply redistributes to the other
    modules."""
    if stat == "clean_sheet_60min":
        return fixture.get("real_clean_sheet_score")
    if stat == "goal":
        feature = hub_features.get((player_id, fixture.get("fixture_id")))
        if not feature or feature.get("score_probability") is None:
            return None
        return anytime_prob_to_expected_goals(float(feature["score_probability"]))
    if stat == "assist":
        feature = hub_features.get((player_id, fixture.get("fixture_id")))
        if not feature or feature.get("assist_probability") is None:
            return None
        return anytime_prob_to_expected_goals(float(feature["assist_probability"]))
    return None


RECENT_FORM_STATS = ("goal", "assist")

# Calibration hypotheses, per the Recent Form architectural review - none
# of these are architectural, all three are configurable independently
# (see build_recent_form_rates), and none are derived from data yet.
# decay=0.85: a goal 4 gameweeks old contributes ~0.52 of one from last
# week. lookback=8: independently testable from decay itself - a flat
# average over a longer window is a coherent config too, not fused with
# "use decay at all." k_recent=3.0 (revised down from an initial 6.0
# after the initial value was shown, not just asserted, to guarantee
# Historical Performance stayed the majority vote even at the largest
# sample this window can ever contain - see the review's own k_recent
# quantification table): at k_recent=3, one effective full match
# contributes 25% observed weight, three matches 50%, and the maximum
# possible 8-gameweek decayed sample ~61.8% - still conservative for a
# single cameo, but able to let a sustained run of evidence become the
# majority signal, which k_recent=6 could never do within this window.
RECENT_FORM_DECAY = 0.85
RECENT_FORM_LOOKBACK = 8
RECENT_FORM_K = 3.0


def compute_recent_form_stat(observations, historical_prior, current_gameweek, decay, k_recent):
    """Pure function - no database access, no historical-row lookups, no
    side effects - directly unit-testable with synthetic inputs. Given
    ONE stat's real observations and that player's already-resolved
    historical_shrunk_rate prior, returns the recency-weighted, shrunk
    rate plus the full breakdown recent_form_detail needs.

    observations: [(gameweek, observed_value, minutes), ...]. The CALLER
    (fetch_recent_gameweek_observations) guarantees every row here has a
    real, non-null observed_value for this specific stat - a gameweek
    where this stat was never recorded (actual_goals IS NULL, say) must
    never appear in this list at all; that is the caller's contract, not
    re-derived here. A row with observed_value = 0 (a real, observed
    "didn't score this game") is valid evidence and IS included - the
    observed-zero-vs-unobserved-NULL distinction is enforced entirely by
    which rows the caller includes, not by any check inside this
    function. Rows with minutes <= 0 are additionally excluded here,
    defensively, so the denominator can never be zero or negative
    regardless of what the caller passes in.

    Returns None if no valid observations remain after filtering - "no
    evidence" stays "no evidence," never converted into a rate of 0.

    Two separate steps, kept algebraically distinct (see the review's
    §02/§07):
      Step 1 - recency weighting: weight(gw) = decay ^ (current_gameweek
      - gw - 1), decayed from CALENDAR gameweek distance (a player's
      pre-injury form goes stale while they're out, not frozen until
      their next real appearance).
      Step 2 - shrinkage toward historical_prior, weighted by k_recent
      (in equivalent 90-minute games) against effective_games90 (real
      recency-weighted minutes / 90). Algebraically a weighted average
      of historical_prior and the recency-weighted observed rate, so
      final_shrunk_rate is always bounded between the two (when both are
      non-negative) - a real, checked invariant, not just intended
      behaviour."""
    valid = [(gw, value, minutes) for gw, value, minutes in observations if minutes is not None and minutes > 0]
    if not valid:
        return None

    weighted_value_sum = 0.0
    weighted_minutes_sum = 0.0
    oldest_gw = None
    newest_gw = None
    for gw, value, minutes in valid:
        weight = decay ** (current_gameweek - gw - 1)
        weighted_value_sum += weight * value
        weighted_minutes_sum += weight * minutes
        oldest_gw = gw if oldest_gw is None else min(oldest_gw, gw)
        newest_gw = gw if newest_gw is None else max(newest_gw, gw)

    effective_games90 = weighted_minutes_sum / 90.0
    if effective_games90 <= 0:
        return None

    raw_unweighted_rate = sum(value for _, value, _ in valid) / (sum(minutes for _, _, minutes in valid) / 90.0)
    raw_recency_weighted_rate = weighted_value_sum / effective_games90

    final_shrunk_rate = (weighted_value_sum + k_recent * historical_prior) / (effective_games90 + k_recent)
    observed_weight = effective_games90 / (effective_games90 + k_recent)
    prior_weight = 1.0 - observed_weight

    return {
        "raw_unweighted_rate": raw_unweighted_rate,
        "raw_recency_weighted_rate": raw_recency_weighted_rate,
        "historical_prior_rate": historical_prior,
        "final_shrunk_rate": final_shrunk_rate,
        "observed_weight": observed_weight,
        "prior_weight": prior_weight,
        # Signed diagnostic - how far, and in which direction, shrinkage
        # moved the final rate away from the raw recency-weighted
        # observation: negative when the prior sits below the observed
        # rate (shrinkage pulls the number down), positive when the prior
        # sits above it (pulls up), exactly 0.0 at k_recent=0 (no
        # shrinkage at all - final_shrunk_rate equals the raw rate by
        # construction, see the k_recent=0 identity above).
        "prior_pull": final_shrunk_rate - raw_recency_weighted_rate,
        "effective_weighted_minutes": weighted_minutes_sum,
        "effective_games90": effective_games90,
        "observed_appearances_for_stat": len(valid),
        "oldest_gameweek_used": oldest_gw,
        "newest_gameweek_used": newest_gw,
    }


def fetch_recent_gameweek_observations(cur, game_id, current_gameweek, lookback=RECENT_FORM_LOOKBACK):
    """Layer 1 - database access ONLY, no recency/shrinkage math, no
    historical-row lookups. Returns
    {player_id: {"goal": [(gw, value, minutes), ...], "assist": [...],
                 "playing_appearances_in_window": N}}
    from player_gameweek_predictions (migration 0044) - a row enters
    "goal"'s list only when actual_goals IS NOT NULL for that gameweek
    (same for "assist"/actual_assists, independently) - a gameweek with
    real minutes but no attacking breakdown yet (the actual GW1 state -
    see the shipped bug fix, scripts/attach_gameweek_results.py only
    ever writes actual_minutes/actual_points) correctly contributes to
    NEITHER list, not a fabricated zero. playing_appearances_in_window
    counts real minutes-played gameweeks regardless of stat availability
    - a player can have 5 real appearances but only 3 with usable assist
    data; this parent-level figure and each stat's own
    observed_appearances_for_stat (see compute_recent_form_stat) answer
    different questions and are both kept.

    Period-mode games (no gameweek calendar, e.g. Dream Team pre-season)
    have no concept of "current gameweek" to look back from, so this
    returns {} for them."""
    if current_gameweek is None:
        return {}
    cur.execute(
        """
        select gp.player_id, pgp.gameweek, pgp.actual_goals, pgp.actual_assists, pgp.actual_minutes
        from player_gameweek_predictions pgp
        join game_players gp on gp.id = pgp.game_player_id
        where pgp.game_id = %s and pgp.gameweek < %s and pgp.gameweek >= %s - %s
          and pgp.actual_minutes is not null
        order by gp.player_id, pgp.gameweek
        """,
        (game_id, current_gameweek, current_gameweek, lookback),
    )
    out = {}
    for player_id, gameweek, actual_goals, actual_assists, actual_minutes in cur.fetchall():
        entry = out.setdefault(player_id, {"goal": [], "assist": [], "playing_appearances_in_window": 0})
        minutes = float(actual_minutes)
        if minutes > 0:
            entry["playing_appearances_in_window"] += 1
        if actual_goals is not None:
            entry["goal"].append((gameweek, float(actual_goals), minutes))
        if actual_assists is not None:
            entry["assist"].append((gameweek, float(actual_assists), minutes))
    return out


def build_recent_form_rates(
    players, historical_by_player_id, position_avg, weights, cur, game_id, current_gameweek,
    lookback=RECENT_FORM_LOOKBACK, decay=RECENT_FORM_DECAY, k_recent=RECENT_FORM_K,
):
    """Layer 3 - orchestration. Ties Layer 1 (fetch_recent_gameweek_observations)
    and Layer 2 (compute_recent_form_stat, historical_shrunk_rate) together
    once per player, per gameweek run - Recent Form has no fixture
    dimension, so this is computed once in main() and reused across
    however many fixtures a player has this scoring period, exactly like
    the module it replaces.

    Returns {player_id: {"goal"?: {"rate": x, "detail": {...}}, "assist"?: {...}}} -
    compute_module_rate_recent_form reads "rate", the Engine Validation
    inputs layer reads "detail" (recent_form_detail, per player)."""
    observations_by_player = fetch_recent_gameweek_observations(cur, game_id, current_gameweek, lookback)
    if not observations_by_player:
        return {}

    out = {}
    for _, position, player_id in players:
        obs = observations_by_player.get(player_id)
        if not obs:
            continue
        historical_row = historical_by_player_id.get(player_id)
        stats = {}
        for stat in RECENT_FORM_STATS:
            stat_observations = obs.get(stat, [])
            if not stat_observations:
                continue
            # §01's fallback chain: historical_shrunk_rate always resolves
            # (steps 1/2 of the chain are the SAME formula's shrinkage
            # behaviour) as long as historical_row exists - step 3 (no
            # signal) fires only if it doesn't, which main()'s existing
            # data flow should never produce for a real player, but is
            # not assumed here regardless.
            if historical_row is None:
                continue
            prior = historical_shrunk_rate(stat, historical_row, position, position_avg, weights)
            result = compute_recent_form_stat(stat_observations, prior, current_gameweek, decay, k_recent)
            if result is not None:
                stats[stat] = {"rate": result["final_shrunk_rate"], "detail": result}
        if stats:
            out[player_id] = {
                **stats,
                "_parent": {
                    "lookback_gameweeks": lookback,
                    "decay": decay,
                    "k_recent": k_recent,
                    "decay_basis": "calendar_gameweek",
                    "playing_appearances_in_window": obs["playing_appearances_in_window"],
                    # Not built yet - see the Recent Form architectural
                    # review's schedule-strength investigation:
                    # team_fixture_difficulty is an unsnapshotted view and
                    # every real query path that reads its sources lacks a
                    # computed_at <= kickoff_at filter (183 real rows
                    # already have a post-kickoff computed_at, confirmed
                    # live) - an absent diagnostic here, not a historically
                    # inaccurate one.
                    "schedule_strength": None,
                    "schedule_strength_source": "not_available",
                },
            }
    return out


def compute_module_rate_recent_form(stat, player_id, recent_form_rates):
    """This player's own recency-weighted, historical-shrunk per-90 rate -
    see build_recent_form_rates/compute_recent_form_stat. None whenever
    no completed gameweek data exists yet for this player (the universal
    case pre-season), AND None for this specific stat if this player has
    real minutes but no real goal/assist breakdown for it yet - never a
    fabricated early guess either way."""
    if stat not in RECENT_FORM_STATS:
        return None
    player_rates = recent_form_rates.get(player_id)
    if not player_rates:
        return None
    stat_entry = player_rates.get(stat)
    if not stat_entry:
        return None
    return stat_entry["rate"]


def build_recent_form_detail(recent_form_rates, player_id):
    """Engine Validation's recent_form_detail (see the implementation
    plan's §07 schema) - {"goal": StatDetail|None, "assist": StatDetail|None,
    <parent-level fields>} or None if this player has no Recent Form
    signal for either stat this run. A stat key is entirely absent (not
    a zero-filled placeholder) whenever that stat had no real
    observations, mirroring build_module_detail_report's own "excluded,
    not faked" discipline."""
    player_rates = recent_form_rates.get(player_id)
    if not player_rates:
        return None
    detail = {stat: player_rates[stat]["detail"] for stat in RECENT_FORM_STATS if stat in player_rates}
    detail.update(player_rates["_parent"])
    return detail


def blend_module_rates(module_rates, module_weights):
    """Weighted average of whichever modules actually have a value for
    this stat/player/fixture, renormalized among just those - a module
    with no signal here (e.g. bookmaker_intelligence for 'assist', or for
    any player with no real/baseline goal odds yet) is EXCLUDED rather
    than treated as a fabricated 0, so it can't drag a legitimate
    estimate down just because one signal source hasn't populated yet.
    Falls back to a plain average of whatever's available if none of the
    available modules have a configured weight (a game with no
    projection_module_weights seed rows) - never crashes, never returns
    0 while real signal exists.

    Returns (blended_rate, effective_weights) - effective_weights is
    {module: weight_actually_used} for EVERY module key present in
    module_rates (0.0 for one that was unavailable/excluded), always
    summing to 1.0 across whichever modules had data. This is the
    "effective weight after missing-module renormalisation" the Engine
    Validation report shows alongside each module's originally
    CONFIGURED weight - the two differ exactly when one or more modules
    had no data this stat/fixture."""
    all_modules = set(module_rates.keys())
    available = {module: rate for module, rate in module_rates.items() if rate is not None}
    if not available:
        return 0.0, {m: 0.0 for m in all_modules}
    total_weight = sum(module_weights.get(module, 0.0) for module in available)
    if total_weight <= 0:
        n = len(available)
        effective_weights = {m: (1.0 / n if m in available else 0.0) for m in all_modules}
    else:
        effective_weights = {m: (module_weights.get(m, 0.0) / total_weight if m in available else 0.0) for m in all_modules}
    blended = sum(effective_weights[m] * rate for m, rate in available.items())
    return blended, effective_weights


def resolve_module_weights(cur, game_id):
    """{position: {module: weight}} for this game, from
    projection_module_weights (migration 0063) - the configurable,
    DB-editable knob for how much each independent signal source
    contributes to a blended goal/assist/clean-sheet rate. Empty dict
    (blend_module_rates then falls back to a plain average) if this game
    hasn't been seeded yet."""
    cur.execute("select position, module, weight from projection_module_weights where game_id = %s", (game_id,))
    out = {}
    for position, module, weight in cur.fetchall():
        out.setdefault(position, {})[module] = float(weight)
    return out


def fetch_hub_features(cur, fixture_ids):
    """{(player_id, fixture_id): {score_probability, is_estimated,
    assist_probability, assist_is_estimated}} from the Bookmaker
    Intelligence Hub (bookmaker_player_features, migration 0064) for the
    given fixtures - read-only here, this script never writes to the hub
    (see scripts/import_sportmonks_player_props.py for that).
    Game-independent by construction: the hub has no game_id column, so
    the same row serves whichever game is scoring right now.

    is_estimated/assist_is_estimated are deliberately separate columns
    (migration 0069) - goal and assist are independently real-or-
    estimated-or-missing for the same row, so one shared flag couldn't
    represent both."""
    if not fixture_ids:
        return {}
    cur.execute(
        """
        select player_id, fixture_id, score_probability, is_estimated, assist_probability, assist_is_estimated
        from bookmaker_player_features
        where fixture_id = any(%s)
        """,
        (list(fixture_ids),),
    )
    return {
        (player_id, fixture_id): {
            "score_probability": score_probability, "is_estimated": is_estimated,
            "assist_probability": assist_probability, "assist_is_estimated": assist_is_estimated,
        }
        for player_id, fixture_id, score_probability, is_estimated, assist_probability, assist_is_estimated in cur.fetchall()
    }


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

    Also folds in PPM_COMPONENT_COLUMNS (Dream Team's Bonus Points inputs -
    dribbles, tackles, interceptions, etc.) so compute_bonus_points() gets
    the same per-90 shrinkage-prior treatment as every other stat here,
    via one shared function rather than a duplicate averaging pass.
    """
    stat_cols = list(STAT_COLUMNS.values()) + PPM_COMPONENT_COLUMNS
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


# Opportunity Model, Phase A (Minimum Viable Opportunity Model) - see
# memory project-opportunity-model-accepted for the binding scope
# boundary (playing-time only, never event quality) and the Phase A
# implementation plan artifact for the full formula derivation and its
# documented "Risks, Assumptions & Technical Debt" table.
#
# SUB_MINUTES_CEILING/START_MINUTES_FLOOR: no field distinguishes a
# start from a substitute appearance anywhere in this pipeline yet, so
# start_share_from_avg_minutes() below infers a proxy from how long a
# player tends to stay on when they do appear. START_MINUTES_FLOOR
# reuses the same 60-minute threshold cond60_rate already uses
# elsewhere in this file, not a new arbitrary number.
SUB_MINUTES_CEILING = 30.0
START_MINUTES_FLOOR = 60.0
ROTATION_CONGESTION_DISCOUNT = 0.85


def start_share_from_avg_minutes(avg_minutes_per_appearance):
    """Proxy for what fraction of a player's historical appearances were
    starts (as opposed to substitute cameos), inferred from their average
    minutes per appearance - monotonic and bounded [0, 1], not a
    fabricated precise split. An explicitly-labelled Phase A
    approximation, replaced by real start/sub labels in Phase B."""
    if avg_minutes_per_appearance <= SUB_MINUTES_CEILING:
        return 0.0
    if avg_minutes_per_appearance >= START_MINUTES_FLOOR:
        return 1.0
    return (avg_minutes_per_appearance - SUB_MINUTES_CEILING) / (START_MINUTES_FLOOR - SUB_MINUTES_CEILING)


def compute_involvement_rates(players, historical_rows, season_games):
    """
    players: [(game_player_id, position, player_id)]
    historical_rows: {player_id: {..., pt1, pt60, pt90}}
    Returns {pos: {"appearance": x, "cond60": x, "cond90": x, "avg_minutes_per_appearance": x,
                   "start_rate": x, "appear_given_not_started": x, "avg_sub_minutes": x}} -
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

    start_rate / appear_given_not_started / avg_sub_minutes (added for the
    Opportunity Model, Phase A - see compute_opportunity()) are position
    priors built from the SAME single pass, using start_share_from_avg_
    minutes()'s proxy split since no real start/sub label exists in the
    data yet - see the Phase A implementation plan's "Risks, Assumptions &
    Technical Debt" table for this approximation's documented limits.
    """
    totals = {
        pos: {
            "pt1": 0.0, "pt60": 0.0, "pt90": 0.0, "minutes": 0.0, "players": 0,
            "start_pt1": 0.0, "sub_minutes_sum": 0.0, "sub_pt1_sum": 0.0,
        }
        for pos in POSITIONS
    }
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
        raw_pt1 = row["pt1"]
        if raw_pt1 > 0:
            avg_min = row["minutes_played"] / raw_pt1
            t["start_pt1"] += raw_pt1 * start_share_from_avg_minutes(avg_min)
            # This player's OWN average reads as "mostly a substitute" -
            # counts toward the sub-minutes cohort used for
            # avg_sub_minutes below. A real (if coarse) proxy cohort, not
            # a guess - see compute_opportunity()'s docstring.
            if avg_min <= SUB_MINUTES_CEILING:
                t["sub_minutes_sum"] += row["minutes_played"]
                t["sub_pt1_sum"] += raw_pt1
    out = {}
    for pos in POSITIONS:
        pt1_total = totals[pos]["pt1"]
        players_n = totals[pos]["players"]
        start_pt1 = totals[pos]["start_pt1"]
        non_start_pt1 = pt1_total - start_pt1
        non_start_games = max(players_n * season_games - start_pt1, 1.0)
        out[pos] = {
            "appearance": (pt1_total / (players_n * season_games)) if players_n else 0.0,
            "cond60": (totals[pos]["pt60"] / pt1_total) if pt1_total else 0.0,
            "cond90": (totals[pos]["pt90"] / pt1_total) if pt1_total else 0.0,
            # 70.0 fallback only fires if literally every player at this
            # position has zero historical minutes - shouldn't happen in
            # practice but avoids a div/0 in the (impossible in normal
            # data) all-new-position case.
            "avg_minutes_per_appearance": (totals[pos]["minutes"] / pt1_total) if pt1_total else 70.0,
            # start_given_appeared is PT1-denominated (not season_games-
            # denominated) deliberately - see compute_opportunity()'s
            # P(start) construction, which multiplies this by appearance
            # rate rather than using it as a standalone rate. Using PT1
            # here (not season_games) is what lets a confirmed impact-sub
            # player's real sample size actually pull their own estimate
            # down, instead of always reverting to this same position
            # average regardless of how much real evidence exists -
            # caught by testing this against a real player before wiring
            # this in (see the Phase A risk log).
            "start_given_appeared": (start_pt1 / pt1_total) if pt1_total else 0.0,
            "appear_given_not_started": (non_start_pt1 / non_start_games) if players_n else 0.0,
            # 20.0 fallback only fires if literally no player at this
            # position ever reads as "mostly a substitute" - possible for
            # a thin position/pool, fails to a documented round-number
            # default rather than a div/0.
            "avg_sub_minutes": (totals[pos]["sub_minutes_sum"] / totals[pos]["sub_pt1_sum"]) if totals[pos]["sub_pt1_sum"] else 20.0,
        }
    return out


def fetch_rotation_congestion(cur, fixture_ids):
    """{fixture_id: bool} - a first-pass, uniform-per-fixture rotation-risk
    signal: True if this fixture is a cup/non-league competition, or
    either side's previous fixture was less than 4 days earlier. NOT the
    per-player exposure / team-level rotation model from
    project-opportunity-model-research - that's a later phase. Every
    player at a flagged fixture receives the same discount
    (ROTATION_CONGESTION_DISCOUNT) regardless of their own role, an
    explicit Phase A simplification - see the implementation plan's risk
    log. Fails open (False) on missing competition/date data rather than
    guessing."""
    if not fixture_ids:
        return {}
    cur.execute(
        "select id, competition, home_team_id, away_team_id, kickoff_at from fixtures where id = any(%s)",
        (list(fixture_ids),),
    )
    target_fixtures = cur.fetchall()
    out = {}
    for row in target_fixtures:
        fixture_id, competition, home_id, away_id, kickoff_at = row
        if competition is None or kickoff_at is None:
            out[fixture_id] = False
            continue
        # Both games this applies to (FanTeam, Dream Team) are the same
        # Premier League - 'soccer_epl' confirmed live as the real
        # competition key for it, distinct from 'soccer_england_efl_cup'
        # etc. Hardcoded rather than derived per-game since both games
        # share the exact same real fixture pool.
        is_cup = competition != "soccer_epl"
        cur.execute(
            "select max(kickoff_at) from fixtures where (home_team_id = %s or away_team_id = %s) and kickoff_at < %s",
            (home_id, home_id, kickoff_at),
        )
        home_prev = cur.fetchone()[0]
        cur.execute(
            "select max(kickoff_at) from fixtures where (home_team_id = %s or away_team_id = %s) and kickoff_at < %s",
            (away_id, away_id, kickoff_at),
        )
        away_prev = cur.fetchone()[0]
        short_turnaround = False
        for prev in (home_prev, away_prev):
            if prev is not None and (kickoff_at - prev).days < 4:
                short_turnaround = True
        out[fixture_id] = bool(is_cup or short_turnaround)
    return out


def compute_opportunity_confidence(minutes_played, live_status_applied):
    """0-100 STRUCTURAL confidence only (sample size + whether live status
    was available this fixture) - mirrors compute_data_confidence()'s
    coverage x sample-size shape. Deliberately does NOT attempt a
    football-uncertainty number (rotation/tactical volatility) in Phase A -
    per project-opportunity-model-research, that axis has nothing real to
    measure from until the team-level rotation model exists. See
    opportunity_detail's "football_uncertainty": None in compute_opportunity()."""
    coverage_factor = 1.0 if live_status_applied else 0.6
    games90 = minutes_played / 90.0
    sample_factor = 1.0 if games90 >= 5 else max(0.4, 0.4 + 0.12 * games90)
    return round(100 * max(0.0, min(1.0, coverage_factor * sample_factor)))


# Live-status -> P(start) blend targets. Reuses LINEUP_MULTIPLIERS'/
# STATUS_MULTIPLIERS' own already-calibrated numbers (defined above,
# still used unchanged by status_multiplier() until Milestone 2 removes
# that call site) - not a new set of guesses. Blend weights (how much to
# trust the live signal vs. history) are a defensible starting point,
# explicitly flagged for Performance Lab calibration once real live-
# status-vs-outcome data accumulates - see the implementation plan's risk
# log.
OPPORTUNITY_HARD_OUT_STATUSES = {"injured", "suspended", "not_available", "gameweek_off"}
OPPORTUNITY_LINEUP_BLEND = {
    "confirmed_starting": (1.0, 0.97),
    "confirmed_not_in_squad": (1.0, 0.0),
    "confirmed_benched": (1.0, 0.02),
    "expected": (0.3, 0.95),
    "might_start": (0.4, 0.75),
    "not_expected": (0.4, 0.35),
}


def compute_opportunity(historical_row, position, pos_inv, weights, lineup, status, is_transferred, is_congested):
    """The Opportunity Model (Phase A - Minimum Viable Opportunity Model).
    Returns (expected_minutes_fraction, opportunity_detail).

    Scoped STRICTLY to playing time, per project-opportunity-model-
    accepted: P(start), P(appear | didn't start), and the opportunity
    (in minutes) if either - never reads or influences anything about
    event rates. Replaces the single blended appearance_rate x avg_
    minutes_per_appearance number project_player_stats used to compute
    inline, decomposing it into the actual generative sequence (manager
    picks XI -> player starts or doesn't -> if not, may appear as a sub)
    instead of averaging over it.

    Every approximation below is real and documented, not hidden - see
    the Phase A implementation plan's "Risks, Assumptions & Technical
    Debt" table for why each one is reasonable today and which later
    phase removes it. In short: no field distinguishes a start from a
    sub-appearance anywhere in this pipeline yet, so start_share_from_
    avg_minutes() infers a proxy from how long a player tends to stay on
    when they do appear, and several position-level priors below (P(start),
    P(appear | not started), sub-appearance minutes) are built from that
    same proxy split rather than a real label.

    lineup/status should be None for anything but the PRIMARY fixture -
    live team news doesn't exist for a fixture two gameweeks out, same
    simplification module_detail_scope already documents elsewhere in
    this file."""
    k = weights["shrinkage_games"]
    k_effective = k * 2.0 if is_transferred else k
    season_games = weights["season_games"]

    raw_pt1 = historical_row["pt1"]
    minutes_played = historical_row["minutes_played"]
    pt1 = max(raw_pt1, 1.0)
    pt60 = historical_row["pt60"]
    pt90 = historical_row["pt90"]

    avg_min = (minutes_played / raw_pt1) if raw_pt1 > 0 else pos_inv["avg_minutes_per_appearance"]
    start_share = start_share_from_avg_minutes(avg_min)

    # --- P(start): historical base rate, then live status update ---
    # Deliberately two multiplied stages, not one shrinkage step directly
    # against season_games: P(start) = P(appear at all) x P(start | appear).
    # appearance_rate reuses the exact formula project_player_stats
    # already trusted for this; start_given_appeared is shrunk using PT1
    # (real appearances) as its own local sample size, not season_games -
    # collapsing straight to one shrinkage step against season_games
    # would let a confirmed impact-sub player's real evidence (many real
    # appearances, all short) vanish the moment start_share is 0, since
    # raw_pt1 * 0 contributes no weight regardless of how large raw_pt1
    # is. Caught by testing this against a real player before wiring this
    # in - see the Phase A risk log.
    appearance_rate = (raw_pt1 + k_effective * pos_inv["appearance"]) / (season_games + k_effective)
    start_given_appeared = (raw_pt1 * start_share + k_effective * pos_inv["start_given_appeared"]) / (pt1 + k_effective)
    p_start_historical = appearance_rate * start_given_appeared

    p_start = p_start_historical
    live_status_applied = False
    if status in OPPORTUNITY_HARD_OUT_STATUSES:
        p_start = 0.0
        live_status_applied = True
    elif lineup in OPPORTUNITY_LINEUP_BLEND:
        live_weight, live_value = OPPORTUNITY_LINEUP_BLEND[lineup]
        p_start = live_weight * live_value + (1.0 - live_weight) * p_start_historical
        live_status_applied = True

    # --- Rotation/congestion: first-pass uniform discount (Component 7) ---
    if is_congested and status not in OPPORTUNITY_HARD_OUT_STATUSES and lineup != "confirmed_not_in_squad":
        p_start *= ROTATION_CONGESTION_DISCOUNT
    p_start = max(0.0, min(1.0, p_start))

    # --- P(appear | didn't start) (Component 3) ---
    non_start_pt1 = raw_pt1 * (1.0 - start_share)
    non_start_games = max(season_games - raw_pt1 * start_share, 1.0)
    p_appear_if_not_started = (non_start_pt1 + k_effective * pos_inv["appear_given_not_started"]) / (non_start_games + k_effective)
    if status in OPPORTUNITY_HARD_OUT_STATUSES or lineup == "confirmed_not_in_squad":
        p_appear_if_not_started = 0.0
    p_appear_if_not_started = max(0.0, min(1.0, p_appear_if_not_started))

    # --- Opportunity if starting (Component 2), early-substitution risk
    # falls out for free (Component 5) - a 3-bucket construction that
    # reinterprets cond60/cond90 (formally defined relative to ALL
    # appearances) as if conditioned on starting specifically, since sub
    # appearances rarely reach 60+ minutes in practice. ---
    cond60_rate = (pt60 + k * pos_inv["cond60"]) / (pt1 + k)
    cond90_rate = (pt90 + k * pos_inv["cond90"]) / (pt1 + k)
    effective_start_share = max(start_share, 0.05)
    p_full90 = cond90_rate
    p_60_to_89 = max(0.0, cond60_rate - cond90_rate)
    p_early_sub = max(0.0, effective_start_share - cond60_rate)
    bucket_total = p_full90 + p_60_to_89 + p_early_sub
    if bucket_total > 0:
        opportunity_if_start = (p_full90 * 90.0 + p_60_to_89 * 75.0 + p_early_sub * 35.0) / bucket_total
        early_substitution_risk = p_early_sub / bucket_total
        p_60_plus_given_start = (p_full90 + p_60_to_89) / bucket_total
        p_full90_given_start = p_full90 / bucket_total
    else:
        opportunity_if_start = pos_inv["avg_minutes_per_appearance"]
        early_substitution_risk = None
        p_60_plus_given_start = cond60_rate
        p_full90_given_start = cond90_rate

    # --- Opportunity if appearing as a substitute (Component 4) - a
    # position-level prior, since no personal start/sub split exists yet
    # to draw a player-specific number from. ---
    opportunity_if_sub = pos_inv["avg_sub_minutes"]

    # --- Combine - the output interface is unchanged, everything
    # downstream still just multiplies raw_rate * expected_minutes_fraction. ---
    expected_minutes_fraction = min(
        1.0,
        (p_start * opportunity_if_start + (1.0 - p_start) * p_appear_if_not_started * opportunity_if_sub) / 90.0,
    )

    # --- Scoring-stat probabilities (Component 6) - "appearance"/
    # "minutes_60_plus"/"played_full_match" are real priced stats in
    # game_scoring_rules (fanteam: 1/3/1 pts - see migration 0021), not
    # just internal telemetry. This replaces the same appearance_rate x
    # cond60_rate/cond90_rate formula project_player_stats used to compute
    # inline, asked of the new decomposed model instead: a sub appearance
    # is assumed not to reach 60+ minutes (per the bucket construction
    # above, which already reflects that sub cameos rarely do), so only
    # the starting branch contributes to p_60_plus/p_full_match.
    p_appear = p_start + (1.0 - p_start) * p_appear_if_not_started
    p_60_plus = p_start * p_60_plus_given_start
    p_full_match = p_start * p_full90_given_start

    structural_confidence = compute_opportunity_confidence(minutes_played, live_status_applied)

    opportunity_detail = {
        "p_start": round(p_start, 4),
        "p_start_historical": round(p_start_historical, 4),
        "p_appear_if_not_started": round(p_appear_if_not_started, 4),
        "opportunity_if_start": round(opportunity_if_start, 2),
        "opportunity_if_sub": round(opportunity_if_sub, 2),
        "early_substitution_risk": round(early_substitution_risk, 4) if early_substitution_risk is not None else None,
        "start_share_proxy": round(start_share, 4),
        "p_appear": round(p_appear, 4),
        "p_60_plus": round(p_60_plus, 4),
        "p_full_match": round(p_full_match, 4),
        "is_transferred": bool(is_transferred),
        "is_congested": bool(is_congested),
        "live_status_applied": live_status_applied,
        "structural_confidence": structural_confidence,
        # Deliberately not modeled in Phase A - see
        # project-opportunity-model-research and compute_opportunity_confidence()'s
        # own docstring. None, not fabricated.
        "football_uncertainty": None,
        "expected_minutes_fraction": round(expected_minutes_fraction, 4),
    }
    return expected_minutes_fraction, opportunity_detail


def fetch_transferred_player_ids(cur):
    """Every player_id with at least one team_changed activity_log event
    on record (see import_fanteam_live.py's log_event(cur, "team_changed",
    ...)) - a real-world transfer (or FanTeam correcting/reclassifying a
    club) means we no longer know which club their historical goals/
    assists actually belong to. Game-independent (activity_log isn't
    scoped to one fantasy game) since a transfer is a real-world fact,
    not a per-game one.

    Feeds is_transferred into compute_opportunity() (see main()), which
    doubles the shrinkage strength (k_effective) toward the position
    average for a transferred player - their pre-transfer historical
    minutes pattern is less trustworthy evidence of their NEW club's
    rotation/starting pattern. (Previously also fed Player Role V1's
    transfer_attribution_uncertain flag - removed along with that module;
    this function's Opportunity Model usage is unaffected.)"""
    cur.execute("select distinct (details->>'player_id')::bigint from activity_log where event_type = 'team_changed'")
    return {row[0] for row in cur.fetchall()}


# Rough Premier League-wide norms, used only as a last resort when a game
# has no real PT1/PT60/PT90 export at all (Dream Team's CSV doesn't carry
# these fields - see the fallback's call site in main()). Not derived from
# this project's own data, since none exists yet to derive them from -
# same "guessed but clearly labeled, fails safe" spirit as
# LINEUP_MULTIPLIERS above.
ASSUMED_MINUTES_PER_APPEARANCE = 75.0
ASSUMED_COND60_RATE = 0.82
ASSUMED_COND90_RATE = 0.55


def _implied_involvement(raw_pt1, raw_pt60, raw_pt90, minutes_played):
    """pt1/pt60/pt90 for one player, falling back to a minutes_played-only
    proxy when the real values are all zero but the player clearly did
    play (minutes_played > 0). Without this, a game with no PT1/60/90 data
    at all would collapse appearance_rate - and with it expected_minutes_
    fraction, which every other per-fixture stat is multiplied through -
    toward 0 for its entire player pool, not just the appearance stat
    itself."""
    pt1, pt60, pt90 = float(raw_pt1), float(raw_pt60), float(raw_pt90)
    if pt1 <= 0 and minutes_played > 0:
        pt1 = minutes_played / ASSUMED_MINUTES_PER_APPEARANCE
        pt60 = pt1 * ASSUMED_COND60_RATE
        pt90 = pt1 * ASSUMED_COND90_RATE
    return {"pt1": pt1, "pt60": pt60, "pt90": pt90}


def project_player_stats(
    position, player_id, historical_row, fixture, weights, position_avg, position_involvement,
    hub_features, recent_form_rates, lineup, status, is_transferred, is_congested,
):
    """Per-stat projected count for one player's one fixture (v2-decomposed).
    Returns (projected, expected_minutes_fraction, module_rates_by_stat,
    opportunity_detail) - the fraction is also exposed as predicted_minutes
    on each fixture_breakdown entry in main(), for the Hail Mary Form
    System (player_gameweek_predictions, migration 0044) to freeze - it was
    previously computed here and discarded.

    Playing-time (expected_minutes_fraction, plus the "appearance"/
    "minutes_60_plus"/"played_full_match" scoring stats below) is entirely
    delegated to compute_opportunity() (the Opportunity Model, Phase A) -
    see its own docstring for the full P(start)-based decomposition. lineup/
    status/is_congested should be None/None/False for anything but the
    PRIMARY fixture - live team news and rotation-risk don't exist for a
    fixture two gameweeks out, same simplification module_detail_scope
    already documents elsewhere in this file.

    goal/assist/clean_sheet_60min (MODULAR_STATS) are blended from up to
    4 independent modules (historical/fixture-model/bookmaker/recent-form -
    see compute_module_rate_* and blend_module_rates above) instead of the
    single historical-rate x coalesced-fixture-factor formula every other
    stat below still uses unchanged."""
    k = weights["shrinkage_games"]
    neutral_attack = weights["neutral_attack"]
    neutral_clean_sheet = weights["neutral_clean_sheet"]
    attack_score = float(fixture["attack_score"])
    clean_sheet_score = float(fixture["clean_sheet_score"])

    attack_factor = attack_score / neutral_attack
    clean_sheet_factor = clean_sheet_score / neutral_clean_sheet
    pressure_factor = (1 - clean_sheet_score) / (1 - neutral_clean_sheet)
    factor_by_mode = {"attack": attack_factor, "clean_sheet": clean_sheet_factor, "pressure": pressure_factor, "flat": 1.0}

    module_weights_by_position = weights.get("module_weights", {}).get(position, {})

    games90 = historical_row["minutes_played"] / 90.0

    pos_inv = position_involvement[position]
    expected_minutes_fraction, opportunity_detail = compute_opportunity(
        historical_row, position, pos_inv, weights, lineup, status, is_transferred, is_congested,
    )

    projected = {
        "appearance": opportunity_detail["p_appear"],
        "minutes_60_plus": opportunity_detail["p_60_plus"],
        "played_full_match": opportunity_detail["p_full_match"],
    }
    # Raw (pre-blend) module rates per modular stat - kept alongside the
    # blended `projected` dict purely so main() can build the Engine
    # Validation "what would this module alone have projected" scenario
    # scores (see compute_module_scenario_contributions) without
    # recomputing every module a second time.
    module_rates_by_stat = {}
    for stat, col in STAT_COLUMNS.items():
        rate_scale = STAT_RATE_SCALE.get(stat, 1.0)
        if stat in MODULAR_STATS:
            module_rates = {
                "historical_performance": compute_module_rate_historical(stat, historical_row, position, position_avg, fixture, weights),
                "fixture_model": compute_module_rate_fixture_model(stat, position, position_avg, fixture, weights),
                "bookmaker_intelligence": compute_module_rate_bookmaker(stat, fixture, player_id, hub_features),
                "recent_form": compute_module_rate_recent_form(stat, player_id, recent_form_rates),
            }
            raw_rate, effective_weights = blend_module_rates(module_rates, module_weights_by_position)
            # Everything the Engine Validation report needs per module for
            # this stat: the raw rate before blending (None if that
            # module had no signal), the weight configured in
            # projection_module_weights, and the weight actually used
            # after renormalizing away any module(s) with no data - these
            # two differ exactly when something's missing, which is the
            # whole point of showing both rather than just one number.
            module_rates_by_stat[stat] = {
                "raw_rates": module_rates,
                "configured_weights": dict(module_weights_by_position),
                "effective_weights": effective_weights,
                "final_rate": raw_rate,
            }
            projected[stat] = raw_rate * expected_minutes_fraction * rate_scale
        else:
            raw_rate = (historical_row[col] + k * position_avg[position][col]) / (games90 + k)
            factor = factor_by_mode[STAT_FIXTURE_MODE[stat]]
            projected[stat] = raw_rate * factor * expected_minutes_fraction * rate_scale
    return projected, expected_minutes_fraction, module_rates_by_stat, opportunity_detail


MODULE_NAMES = ("historical_performance", "fixture_model", "bookmaker_intelligence", "recent_form")

MODULE_DISPLAY_NAMES = {
    "historical_performance": "Historical Performance",
    "fixture_model": "Fixture Model",
    "bookmaker_intelligence": "Bookmaker Intelligence",
    "recent_form": "Recent Form",
}


def compute_module_scenario_contributions(module_rates_by_stat, projected_stats, expected_minutes_fraction, position, scoring_rules):
    """For one fixture: 'what would this fixture's modular-stat
    contribution have been if THIS module ALONE had decided goal/assist/
    clean_sheet_60min, with every non-modular stat left exactly as
    actually projected' - priced through the same game_scoring_rules as
    the real score, so directly comparable to it (this is the Engine
    Validation report's per-module figure - see
    frontend/src/app/algorithm-explain/page.tsx). None for a module that
    had no data for ANY modular stat this fixture (e.g. Recent Form
    pre-season) - never a fabricated number."""
    contributions = {}
    for module in MODULE_NAMES:
        scenario_stats = dict(projected_stats)
        has_data = False
        for stat in MODULAR_STATS:
            rate = module_rates_by_stat.get(stat, {}).get("raw_rates", {}).get(module)
            if rate is None:
                continue
            has_data = True
            rate_scale = STAT_RATE_SCALE.get(stat, 1.0)
            scenario_stats[stat] = rate * expected_minutes_fraction * rate_scale
        if not has_data:
            contributions[module] = None
            continue
        total, _ = price_projected_stats(position, scenario_stats, scoring_rules)
        contributions[module] = total
    return contributions


def compute_data_confidence(module_has_data, module_weights, games90):
    """0-100 DATA CONFIDENCE for the blended projection - deliberately
    NOT named "confidence" or "accuracy": this reflects how much of the
    intended signal was actually AVAILABLE (source coverage, module
    availability, historical sample size), never how likely the
    projection is to be correct. It cannot know that - only real
    projected-vs-actual results (the future Performance Lab redesign)
    can calibrate genuine predictive confidence. This is:
      - what fraction of this position's CONFIGURED module weight was
        satisfied by a real value across this gameweek's fixture(s)
        (module_has_data; a module with no data anywhere contributes 0,
        same "excluded, not faked" rule blend_module_rates follows), then
      - damped when the player's own historical sample is thin (a new
        signing's Historical Performance number is real but rests on
        very little evidence)."""
    if not module_weights:
        return 0
    total_weight = sum(module_weights.values())
    if total_weight <= 0:
        return 0
    available_weight = sum(weight for module, weight in module_weights.items() if module_has_data.get(module))
    coverage = available_weight / total_weight
    sample_factor = 1.0 if games90 >= 5 else max(0.4, 0.4 + 0.12 * games90)
    return round(100 * max(0.0, min(1.0, coverage * sample_factor)))


def data_confidence_label(score):
    if score >= 70:
        return "High"
    if score >= 40:
        return "Medium"
    return "Low"


def build_module_detail_report(module_rates_by_stat, position, scoring_rules, expected_minutes_fraction, player_id, fixture, hub_features):
    """The Engine Validation report's core per-stat, per-module table -
    see frontend/src/lib/engineExplainability.ts, the shared TS layer
    that reads this. For each modular stat: the final blended rate, and
    per module the raw (pre-blend) rate, its CONFIGURED weight
    (projection_module_weights), the EFFECTIVE weight actually used after
    renormalizing away any module(s) with no data, and the resulting
    WEIGHTED POINT CONTRIBUTION (effective_weight x raw_rate x expected
    minutes x rate scale x this stat's real point value) - these
    necessarily sum back to the stat's own contribution to the final
    score, unlike the scenario totals in compute_module_scenario_
    contributions (which include unrelated non-modular points and so
    are NOT additive across modules - a different, complementary view,
    never to be labelled "contribution" on its own for that reason)."""
    report = {}
    for stat in MODULAR_STATS:
        detail = module_rates_by_stat.get(stat)
        if not detail:
            continue
        rate_scale = STAT_RATE_SCALE.get(stat, 1.0)
        points_each = scoring_rules.get(("all", stat), scoring_rules.get((position, stat)))
        modules = {}
        for module in MODULE_NAMES:
            raw_rate = detail["raw_rates"].get(module)
            effective_weight = detail["effective_weights"].get(module, 0.0)
            configured_weight = detail["configured_weights"].get(module, 0.0)
            if raw_rate is None or points_each is None:
                weighted_point_contribution = None
            else:
                weighted_point_contribution = round(raw_rate * effective_weight * expected_minutes_fraction * rate_scale * points_each, 4)
            modules[module] = {
                "raw_rate": round(raw_rate, 4) if raw_rate is not None else None,
                "configured_weight": round(configured_weight, 4),
                "effective_weight": round(effective_weight, 4),
                "weighted_point_contribution": weighted_point_contribution,
            }
        report[stat] = {
            "final_rate": round(detail["final_rate"], 4),
            "points_each": points_each,
            "modules": modules,
            "bookmaker_data_source": bookmaker_data_source(stat, fixture, player_id, hub_features),
        }
    return report


def bookmaker_data_source(stat, fixture, player_id, hub_features):
    """'real' | 'estimated' | 'unavailable' - whether Bookmaker
    Intelligence's number for this stat/player/fixture is a direct
    market observation, a baseline scaled from one, or nothing at all.
    Mirrors compute_module_rate_bookmaker's own real-vs-estimated-vs-None
    logic exactly, but returns the LABEL rather than the rate - kept as
    a separate function (not folded into compute_module_rate_bookmaker)
    so that function's return type stays a plain rate-or-None everywhere
    else it's used, and this transparency detail only gets computed
    where the Engine Validation report actually needs it."""
    if stat == "clean_sheet_60min":
        return "real" if fixture.get("real_clean_sheet_score") is not None else "unavailable"
    if stat == "goal":
        feature = hub_features.get((player_id, fixture.get("fixture_id")))
        if not feature or feature.get("score_probability") is None:
            return "unavailable"
        return "estimated" if feature.get("is_estimated") else "real"
    if stat == "assist":
        feature = hub_features.get((player_id, fixture.get("fixture_id")))
        if not feature or feature.get("assist_probability") is None:
            return "unavailable"
        return "estimated" if feature.get("assist_is_estimated") else "real"
    return "unavailable"


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


# Human-readable names for build_explanation() - falls back to the raw
# stat key for anything not listed (safe, just less polished wording).
STAT_DISPLAY_NAMES = {
    "goal": "goals", "assist": "assists", "shot_on_target": "shots on target",
    "big_chance_created": "big chances created", "tackle": "tackles",
    "clean_sheet_60min": "clean sheet chance", "save": "saves",
    "penalty_save": "penalty saves", "goals_conceded_per_2": "goals conceded",
    "own_goal": "own goals", "yellow_card": "yellow cards", "red_card": "red cards",
    "penalty_miss": "penalty misses", "bonus_points": "bonus points",
}
# Near-constant for anyone expected to start (~1 either way) - excluded
# from the explanation because it doesn't say anything about WHY this
# specific player is valued the way they are, unlike every other stat.
EXPLANATION_EXCLUDE = {"appearance", "minutes_60_plus", "played_full_match"}


def build_explanation(priced, top_n=3):
    """Short, honest sentence built from the actual per-stat contributions
    just priced (the neutral-fixture baseline, so it describes the
    player, not a specific opponent) - not a canned template. Confirmed
    nothing like this existed anywhere in this file before (only golf's
    own separate script had one) - a real transparency gap for both games
    this now fixes, not just Dream Team's bonus points."""
    ranked = sorted(
        ((stat, item) for stat, item in priced.items() if stat not in EXPLANATION_EXCLUDE),
        key=lambda pair: abs(pair[1]["contribution"]),
        reverse=True,
    )
    parts = [f"{item['projected']:.2f} {STAT_DISPLAY_NAMES.get(stat, stat)}" for stat, item in ranked[:top_n] if abs(item["contribution"]) >= 0.05]
    if not parts:
        return "Limited historical signal to project from."
    return "Projects " + ", ".join(parts) + " per match."


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
            # module_weights is part of the hashed weights dict on purpose -
            # editing projection_module_weights (migration 0063) is a real
            # tuning change, so it must mint a new algorithm_versions
            # revision the same way any other weight edit does (see
            # get_or_create_algorithm_version's docstring) - Performance
            # Lab needs to be able to attribute an accuracy shift to it.
            module_weights_by_position = resolve_module_weights(cur, game_id)
            algo_id, weights = get_or_create_algorithm_version(
                cur, "v2-decomposed",
                "per-stat projection (goals/assists/clean sheets/cards/saves/shots on target/own goals/"
                "penalty saves) priced through game_scoring_rules, PT1/60/90-based involvement, "
                "self-calibrating neutral_attack, modular goal/assist/clean-sheet blending "
                "(historical/fixture-model/bookmaker via the Bookmaker Intelligence Hub)",
                {**DEFAULT_WEIGHTS_V2, "module_weights": module_weights_by_position},
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
                   coalesce((gps.raw_stats->>'PT90')::numeric, 0) as pt90,
                   gps.raw_stats as raw_stats_all
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

        # Dream Team's raw_stats uses different key names than FanTeam's
        # for the same stat, plus stats FanTeam's export doesn't have at
        # all (see RAW_STAT_ALIASES) - resolved here rather than more
        # hardcoded SQL ->> extracts above, so the FanTeam columns already
        # selected stay untouched. Empty for any game_slug not listed
        # (currently just fanteam), so every aliased key below defaults to
        # 0.0 for it via aliased.get(...).
        raw_stat_aliases = RAW_STAT_ALIASES.get(game_slug, {})

        def resolve_aliased(raw_blob):
            if isinstance(raw_blob, str):
                raw_blob = json.loads(raw_blob)
            raw_blob = raw_blob or {}
            return {internal_key: float(raw_blob.get(csv_key) or 0) for internal_key, csv_key in raw_stat_aliases.items()}

        historical_by_player_id = {}
        for r in raw_players:
            aliased = resolve_aliased(r["raw_stats_all"])
            historical_by_player_id[r["player_id"]] = {
                "total_points": float(r["total_points"]), "minutes_played": r["minutes_played"],
                "goals": r["goals"], "assists": r["assists"], "clean_sheets": r["clean_sheets"], "saves": r["saves"],
                "goals_conceded": r["goals_conceded"], "yellow_cards": r["yellow_cards"], "red_cards": r["red_cards"],
                # Prefer the game-specific alias (e.g. Dream Team's
                # "shotsOnTarget") when this game has one; otherwise fall
                # back to the SQL-extracted FanTeam-named column above -
                # FanTeam's own behavior is completely unchanged.
                "shots_on_target": aliased.get("shots_on_target", float(r["shots_on_target"])),
                "own_goals": float(r["own_goals"]), "penalty_saves": float(r["penalty_saves"]),
                # New Dream Team Player Points stats (migration 0053) -
                # 0.0 for any game without a matching alias (FanTeam).
                "big_chance_created": aliased.get("big_chance_created", 0.0),
                "tackle": aliased.get("tackle", 0.0),
                "penalty_miss": aliased.get("penalty_miss", 0.0),
                # Bonus Points PPM components (Section 3.2.4.4) - see
                # compute_bonus_points(). 0.0 for any game without a
                # matching alias.
                "ppm_dribble": aliased.get("ppm_dribble", 0.0),
                "ppm_cross": aliased.get("ppm_cross", 0.0),
                "ppm_offside": aliased.get("ppm_offside", 0.0),
                "ppm_pass_completion_rate": aliased.get("ppm_pass_completion_rate", 0.0),
                "ppm_interception": aliased.get("ppm_interception", 0.0),
                "ppm_block": aliased.get("ppm_block", 0.0),
                "ppm_goal_outside_area": aliased.get("ppm_goal_outside_area", 0.0),
                "ppm_foul_won": aliased.get("ppm_foul_won", 0.0),
                "ppm_foul_conceded": aliased.get("ppm_foul_conceded", 0.0),
                "ppm_error_leading_to_goal": aliased.get("ppm_error_leading_to_goal", 0.0),
                "ppm_claim": aliased.get("ppm_claim", 0.0),
                "ppm_punch": aliased.get("ppm_punch", 0.0),
                "ppm_keeper_sweep": aliased.get("ppm_keeper_sweep", 0.0),
                # Deliberately NOT floored here (unlike the old behavior) -
                # a genuinely-0 pt1 (no historical minutes at all, e.g. a
                # newly-promoted team's whole squad, who FanTeam's own
                # query used to silently exclude via an inner join) needs
                # to stay distinguishable from "had 1 real appearance" so
                # project_player_stats can fall back to a position-average
                # minutes-per-appearance instead of dividing 0/1 -> 0
                # minutes. The safety floor still applies locally in
                # project_player_stats for the rate formulas themselves.
                #
                # Games without any real PT1/PT60/PT90 export at all
                # (Dream Team's CSV has no such fields) would otherwise
                # collapse EVERY player's appearance_rate toward 0 - not
                # just a missing "appearance" stat, but expected_minutes_
                # fraction itself, which every other per-fixture stat is
                # multiplied through. A minutes_played-only proxy avoids
                # that collapse: assumed averages (75 min/appearance, 82%
                # of appearances reaching 60+, 55% going the full 90) are
                # rough, clearly-labeled Premier League norms, not derived
                # from real Dream Team per-match data (none exists) -
                # revisit if/when this game ever gets real per-gameweek
                # data.
                **_implied_involvement(r["pt1"], r["pt60"], r["pt90"], r["minutes_played"]),
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
        # Feeds is_transferred into compute_opportunity() below - see
        # fetch_transferred_player_ids.
        transferred_player_ids = fetch_transferred_player_ids(cur) if use_v2 else set()
        # Only meaningful for v2 (weights["season_games"] doesn't exist on
        # v1's DEFAULT_WEIGHTS) - v1 never calls project_player_stats.
        position_involvement = (
            compute_involvement_rates(players, historical_by_player_id, weights["season_games"]) if use_v2 else None
        )
        # Bonus Points' pass-completion PPM component (see
        # compute_bonus_points()) needs its own shrinkage prior, computed
        # separately from position_avg_rates since it's a percentage, not
        # a per-90 rate.
        pass_completion_position_avg = (
            compute_pass_completion_position_avg(players, historical_by_player_id) if use_v2 else None
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
        all_fixture_ids = set()
        for (player_id, team_id, fixture_id, kickoff_at, attack_score, clean_sheet_score,
             home_team_id, away_team_id,
             real_home_win_prob, real_draw_prob, real_away_win_prob,
             model_home_win_prob, model_draw_prob, model_away_win_prob) in rows:
            all_kickoffs.append(kickoff_at)
            all_fixture_ids.add(fixture_id)
            real_win, real_draw = _team_side_win_draw(real_home_win_prob, real_draw_prob, real_away_win_prob, team_id, home_team_id)
            model_win, model_draw = _team_side_win_draw(model_home_win_prob, model_draw_prob, model_away_win_prob, team_id, home_team_id)
            real_attack, real_cs = _attack_and_clean_sheet(real_win, real_draw)
            model_attack, model_cs = _attack_and_clean_sheet(model_win, model_draw)
            fixtures_by_player.setdefault(player_id, []).append({
                "fixture_id": fixture_id, "kickoff_at": kickoff_at.isoformat(),
                "attack_score": float(attack_score), "clean_sheet_score": float(clean_sheet_score),
                # Split real-odds-only / model-only components - see
                # compute_module_rate_historical/fixture_model/bookmaker -
                # None when that source genuinely has no row for this fixture.
                "real_attack_score": real_attack, "real_clean_sheet_score": real_cs,
                "model_attack_score": model_attack, "model_clean_sheet_score": model_cs,
            })

        hub_features = fetch_hub_features(cur, all_fixture_ids) if use_v2 else {}
        recent_form_rates = (
            build_recent_form_rates(players, historical_by_player_id, position_avg_rates, runtime_weights, cur, game_id, gameweek)
            if use_v2 else {}
        )
        # Opportunity Model (Phase A) rotation-risk signal - see
        # fetch_rotation_congestion(). Only meaningful for v2, same reason
        # position_involvement above is v2-only.
        rotation_congestion = fetch_rotation_congestion(cur, all_fixture_ids) if use_v2 else {}

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
            # Fetched once per player, before the v1/v2 branch, so the
            # Opportunity Model can consume real live team news for the
            # primary fixture below - previously this lookup happened only
            # after both branches, purely to feed status_multiplier().
            lineup, status = player_status.get(game_player_id, (None, None))
            is_transferred = player_id in transferred_player_ids

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
                # Neutral baseline deliberately ignores live status/rotation
                # (lineup=None, status=None, is_congested=False) - it
                # describes the player's own underlying rate, not any one
                # fixture's team news, same "neutral" spirit as the
                # attack/clean_sheet factors above.
                neutral_stats, neutral_minutes_fraction, _, _ = project_player_stats(
                    position, player_id, historical_row, neutral_fixture, runtime_weights, position_avg_rates,
                    position_involvement, hub_features, recent_form_rates,
                    None, None, is_transferred, False,
                )
                points_per_90, neutral_priced = price_projected_stats(position, neutral_stats, scoring_rules)
                neutral_bonus = compute_bonus_points(
                    position, historical_row, position_avg_rates, pass_completion_position_avg, runtime_weights, neutral_minutes_fraction
                )
                points_per_90 += neutral_bonus
                neutral_priced["bonus_points"] = {"projected": round(neutral_bonus, 4), "points_each": 1, "contribution": round(neutral_bonus, 3)}

                score = 0.0
                fixture_breakdown = []
                module_scenario_totals = {module: None for module in MODULE_NAMES}
                module_has_data = {module: False for module in MODULE_NAMES}
                # Engine Validation's full per-module detail table (see
                # build_module_detail_report) is only captured for the
                # PRIMARY fixture (fixtures[0]) - same established
                # double-gameweek simplification this file already uses
                # for predicted_minutes/fixture_factor above; the
                # aggregate module_scenario_totals below still correctly
                # sums every fixture.
                primary_module_detail = None
                primary_expected_minutes_fraction = None
                primary_opportunity_detail = None
                for fixture_index, fx in enumerate(player_fixtures):
                    # Live team news and rotation-congestion only exist (and
                    # are only meaningful) for the PRIMARY fixture - same
                    # scope as module_detail's own "primary fixture only"
                    # simplification just below.
                    fixture_lineup = lineup if fixture_index == 0 else None
                    fixture_status = status if fixture_index == 0 else None
                    fixture_is_congested = rotation_congestion.get(fx["fixture_id"], False)
                    projected_stats, expected_minutes_fraction, module_rates_by_stat, opportunity_detail = project_player_stats(
                        position, player_id, historical_row, fx, runtime_weights, position_avg_rates,
                        position_involvement, hub_features, recent_form_rates,
                        fixture_lineup, fixture_status, is_transferred, fixture_is_congested,
                    )
                    if fixture_index == 0:
                        primary_module_detail = build_module_detail_report(
                            module_rates_by_stat, position, scoring_rules, expected_minutes_fraction, player_id, fx, hub_features
                        )
                        primary_expected_minutes_fraction = expected_minutes_fraction
                        primary_opportunity_detail = opportunity_detail
                    contribution, priced = price_projected_stats(position, projected_stats, scoring_rules)
                    bonus_points = compute_bonus_points(
                        position, historical_row, position_avg_rates, pass_completion_position_avg, runtime_weights, expected_minutes_fraction
                    )
                    if bonus_points:
                        contribution += bonus_points
                        priced["bonus_points"] = {"projected": round(bonus_points, 4), "points_each": 1, "contribution": round(bonus_points, 3)}
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

                    # Engine Validation report data (see
                    # frontend/src/app/algorithm-explain/page.tsx) - "what
                    # would this fixture have scored if only module X had
                    # decided the modular stats" - same bonus_points added
                    # to every module's scenario (it's non-modular, so
                    # constant across all of them) for a fair, directly
                    # comparable total against the real blended score.
                    scenario_contributions = compute_module_scenario_contributions(
                        module_rates_by_stat, projected_stats, expected_minutes_fraction, position, scoring_rules
                    )
                    for module, value in scenario_contributions.items():
                        if value is None:
                            continue
                        module_has_data[module] = True
                        module_scenario_totals[module] = (module_scenario_totals[module] or 0.0) + value + bonus_points

                data_confidence_score = compute_data_confidence(
                    module_has_data, module_weights_by_position.get(position, {}), historical_row["minutes_played"] / 90.0
                )
                inputs = {
                    "points_per_90": round(points_per_90, 3),
                    "neutral_attack_used": round(runtime_weights["neutral_attack"], 4),
                    # Sample-size signal for the Hail Mary Form System's
                    # confidence formula (scripts/capture_gameweek_predictions.py) -
                    # how many 90-minute games of real history this player's
                    # shrunk rates are actually based on.
                    "games90": round(historical_row["minutes_played"] / 90.0, 2),
                    "fixtures": fixture_breakdown,
                    "explanation": build_explanation(neutral_priced),
                    # Engine Validation report (frontend/src/lib/
                    # engineExplainability.ts) - the primary fixture's full
                    # per-stat, per-module breakdown (raw rate, configured
                    # vs effective weight, weighted point contribution -
                    # see build_module_detail_report), the expected-minutes
                    # factor already used above, and Data Confidence (source
                    # coverage/sample size, NOT predictive accuracy - see
                    # compute_data_confidence).
                    # Explicit scope label so the frontend never silently
                    # implies module_detail covers the whole scoring
                    # period - it's ALWAYS just the primary (first)
                    # fixture; fixture_count > 1 means the final score
                    # includes further fixtures this breakdown doesn't
                    # decompose (a genuine double gameweek - none exist
                    # in the data as of this build, but this stays honest
                    # the moment one does).
                    "module_detail_scope": {"is_primary_fixture_only": True, "fixture_count": len(player_fixtures)},
                    "module_detail": primary_module_detail,
                    # Opportunity Model (Phase A) full breakdown for the
                    # primary fixture - P(start), P(appear | didn't start),
                    # opportunity-if-start/sub, early-substitution risk,
                    # structural confidence - see compute_opportunity().
                    # Same "primary fixture only" scope as module_detail
                    # above, for the same reason.
                    "opportunity_detail": primary_opportunity_detail,
                    # Recent Form's full recency-weighted, historical-
                    # shrunk breakdown per stat - see build_recent_form_rates/
                    # compute_recent_form_stat. Not fixture-scoped at all
                    # (unlike opportunity_detail) - Recent Form produces one
                    # number per player per gameweek run, reused across
                    # every fixture that gameweek, so this is simply the
                    # player's detail, not a "primary fixture" figure.
                    "recent_form_detail": build_recent_form_detail(recent_form_rates, player_id),
                    "expected_minutes_fraction": round(primary_expected_minutes_fraction, 4) if primary_expected_minutes_fraction is not None else None,
                    "data_confidence": {"score": data_confidence_score, "label": data_confidence_label(data_confidence_score)},
                    # Per-module "what if this module alone decided"
                    # SCENARIO totals (None where a module had no data at
                    # all this gameweek) - includes unrelated non-modular
                    # points (saves/cards/bonus/etc), so these are NOT
                    # additive across modules and must never be labelled
                    # "contribution" on their own - see module_detail's
                    # weighted_point_contribution for the additive view.
                    "module_scenarios": {
                        module: (round(value, 3) if value is not None else None)
                        for module, value in module_scenario_totals.items()
                    },
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

            raw_score_before_multiplier = score
            # v2: availability is already fully reflected in P(start) via
            # compute_opportunity() (live status + rotation congestion both
            # feed it above) - a second post-hoc multiplier here would
            # double-count it. v1 never calls project_player_stats/
            # compute_opportunity at all, so status_multiplier() remains
            # its only availability mechanism, unchanged - see
            # scripts/verify_player_status_mapping.py, which still imports
            # LINEUP_MULTIPLIERS/STATUS_MULTIPLIERS directly.
            if use_v2:
                multiplier = 1.0
            else:
                multiplier = status_multiplier(lineup, status)
            if multiplier != 1.0:
                score *= multiplier
            inputs["status"] = {"lineup": lineup, "status": status, "multiplier": multiplier}

            # Reconciliation - Engine Validation report (see
            # frontend/src/lib/engineExplainability.ts). TWO independent
            # checks, neither comparing a value against itself:
            #
            # Check 1 (primary fixture): rebuilds the primary fixture's
            # expected total from module_detail's weighted_point_
            # contribution figures (build_module_detail_report - a wholly
            # separate function/code path) plus the non-modular stats and
            # bonus points, and compares it to fixture_breakdown[0]'s own
            # "contribution" (produced earlier by price_projected_stats +
            # compute_bonus_points). Two independently-written
            # computations over the same underlying rates - a real
            # regression check, not a tautology.
            #
            # Check 2 (full score): re-sums EVERY fixture's stored
            # "contribution" fresh from fixture_breakdown (not the live
            # `score` accumulator variable used during the loop - a
            # separate pass over the persisted list, so a bug that let
            # the accumulator and the stored breakdown drift apart would
            # be caught), applies the availability multiplier exactly
            # once, and compares to the real final score. All comparisons
            # use unrounded values - rounding is display-only.
            if use_v2 and primary_module_detail and fixture_breakdown:
                RECONCILE_TOLERANCE = 0.01

                modular_sum = sum(
                    (m.get("weighted_point_contribution") or 0.0)
                    for stat_detail in primary_module_detail.values()
                    for m in stat_detail["modules"].values()
                )
                primary_fixture = fixture_breakdown[0]
                non_modular_sum = sum(
                    item["contribution"]
                    for stat, item in primary_fixture["stats"].items()
                    if stat not in MODULAR_STATS and stat != "bonus_points"
                )
                bonus_component = primary_fixture["stats"].get("bonus_points", {}).get("contribution", 0.0)
                expected_primary_total = modular_sum + non_modular_sum + bonus_component
                actual_primary_total = primary_fixture["contribution"]
                primary_difference = expected_primary_total - actual_primary_total
                primary_check = {
                    "expected": round(expected_primary_total, 6),
                    "actual": round(actual_primary_total, 6),
                    "difference": round(primary_difference, 6),
                    "tolerance": RECONCILE_TOLERANCE,
                    "passed": abs(primary_difference) <= RECONCILE_TOLERANCE,
                }

                expected_pre_availability = sum(fx["contribution"] for fx in fixture_breakdown)
                additional_fixtures_subtotal = expected_pre_availability - fixture_breakdown[0]["contribution"]
                expected_final = expected_pre_availability * multiplier
                full_difference = expected_final - score
                full_score_check = {
                    "expected": round(expected_final, 6),
                    "actual": round(score, 6),
                    "difference": round(full_difference, 6),
                    "tolerance": RECONCILE_TOLERANCE,
                    "passed": abs(full_difference) <= RECONCILE_TOLERANCE,
                }

                inputs["reconciliation"] = {
                    "primary_fixture_check": primary_check,
                    "full_score_check": full_score_check,
                    "modular_sum": round(modular_sum, 4),
                    "non_modular_sum": round(non_modular_sum, 4),
                    "bonus": round(bonus_component, 4),
                    "primary_fixture_subtotal": round(fixture_breakdown[0]["contribution"], 4),
                    "additional_fixtures_subtotal": round(additional_fixtures_subtotal, 4),
                    "pre_availability_total": round(expected_pre_availability, 4),
                    "availability_multiplier": multiplier,
                    "final_score": round(score, 4),
                }

                if not primary_check["passed"] or not full_score_check["passed"]:
                    label = f"gameweek {gameweek}" if gameweek is not None else f"{period_start} to {period_end}"
                    name = full_name_by_game_player_id.get(game_player_id, f"game_player_id {game_player_id}")
                    print(
                        f"  [RECONCILIATION FAILED] {name} ({game_slug}, {label}, algorithm_version_id={algo_id}): "
                        f"primary_check={primary_check}, full_score_check={full_score_check}"
                    )

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
