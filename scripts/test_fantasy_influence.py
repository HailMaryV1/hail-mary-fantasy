"""
test_fantasy_influence.py
--------------------------
Unit tests for Fantasy Influence's pure-compute layer (compute_projections.py):
historical_shrunk_rate_ratio, compute_attacking_involvement_indices,
combine_involvement_index, compute_module_rate_fantasy_influence,
build_fantasy_influence_detail. Synthetic fixtures only - no DB required.

RUN:
    python3 scripts/test_fantasy_influence.py
"""

import unittest

from compute_projections import (
    combine_involvement_index,
    compute_attacking_involvement_indices,
    compute_module_rate_fantasy_influence,
    historical_shrunk_rate_ratio,
)

WEIGHTS = {"shrinkage_games": 10}

# A single flat position average - every "average" player in this test
# fixture scores/assists/shoots at exactly this per-90 rate.
POSITION_AVG = {
    "FWD": {"goals": 0.4, "assists": 0.2, "shots_on_target": 1.2},
}


def make_row(goals=0.0, assists=0.0, shots_on_target=0.0, minutes_played=900.0):
    """games90 = minutes_played / 90; 900 minutes = 10 full games90, well
    past shrinkage_games=10 so the real rate dominates over the prior."""
    return {
        "goals": goals,
        "assists": assists,
        "shots_on_target": shots_on_target,
        "minutes_played": minutes_played,
    }


class TestHistoricalShrunkRateRatio(unittest.TestCase):
    def test_zero_history_collapses_to_one(self):
        row = make_row(minutes_played=0.0)
        ratio = historical_shrunk_rate_ratio("goal", row, "FWD", POSITION_AVG, WEIGHTS)
        self.assertAlmostEqual(ratio, 1.0, places=6)

    def test_above_average_player_exceeds_one_uncapped(self):
        # 10 games90 real sample, way above the 0.4/90 position average:
        # shrunk = (20 + 10*0.4) / (10+10) = 1.2, ratio = 1.2/0.4 = 3.0.
        row = make_row(goals=20.0, minutes_played=900.0)
        ratio = historical_shrunk_rate_ratio("goal", row, "FWD", POSITION_AVG, WEIGHTS)
        self.assertGreater(ratio, 2.0)  # no ceiling anywhere in this construction

    def test_below_average_player_under_one(self):
        row = make_row(goals=0.5, minutes_played=900.0)
        ratio = historical_shrunk_rate_ratio("goal", row, "FWD", POSITION_AVG, WEIGHTS)
        self.assertLess(ratio, 1.0)

    def test_missing_position_average_excluded_not_fabricated(self):
        row = make_row(goals=5.0, minutes_played=900.0)
        zero_avg = {"FWD": {"goals": 0.0, "assists": 0.2, "shots_on_target": 1.2}}
        ratio = historical_shrunk_rate_ratio("goal", row, "FWD", zero_avg, WEIGHTS)
        self.assertIsNone(ratio)


class TestCombineInvolvementIndex(unittest.TestCase):
    def test_both_present_weighted_blend(self):
        result = combine_involvement_index(idx_process=2.0, idx_cross_outcome=1.0, process_weight=0.6)
        self.assertAlmostEqual(result, 0.6 * 2.0 + 0.4 * 1.0, places=6)

    def test_process_missing_falls_back_to_cross_outcome(self):
        self.assertEqual(combine_involvement_index(None, 1.5), 1.5)

    def test_cross_outcome_missing_falls_back_to_process(self):
        self.assertEqual(combine_involvement_index(1.5, None), 1.5)

    def test_both_missing_is_none(self):
        self.assertIsNone(combine_involvement_index(None, None))


class TestComputeModuleRateFantasyInfluence(unittest.TestCase):
    def test_zero_history_matches_historical_performance_alone(self):
        """Everything collapses to the position average, so Fantasy
        Influence's contribution should equal historical_shrunk_rate
        alone (scaling_index == 1.0)."""
        row = make_row(minutes_played=0.0)
        fi_rate = compute_module_rate_fantasy_influence("goal", row, "FWD", POSITION_AVG, WEIGHTS)
        self.assertAlmostEqual(fi_rate, POSITION_AVG["FWD"]["goals"], places=6)

    def test_elite_attacker_amplified_uncapped(self):
        """High goal, assist, AND shot volume - the goal contribution
        should end up meaningfully ABOVE the player's own already-elevated
        historical rate (no cap), since the scaling index (from shot
        share + assist involvement, not goal itself) is also >1."""
        row = make_row(goals=12.0, assists=6.0, shots_on_target=36.0, minutes_played=900.0)
        fi_rate = compute_module_rate_fantasy_influence("goal", row, "FWD", POSITION_AVG, WEIGHTS)
        from compute_projections import historical_shrunk_rate

        base_rate = historical_shrunk_rate("goal", row, "FWD", POSITION_AVG, WEIGHTS)
        self.assertGreater(fi_rate, base_rate)  # amplified beyond the raw historical rate

    def test_no_self_reference_perturbing_goals_leaves_goal_scaling_unchanged(self):
        """The regression test for the bug this design caught: goal's
        scaling multiplier (shot-on-target + assist involvement) must be
        totally unaffected by the player's own goal tally."""
        row_low_goals = make_row(goals=1.0, assists=6.0, shots_on_target=36.0, minutes_played=900.0)
        row_high_goals = make_row(goals=30.0, assists=6.0, shots_on_target=36.0, minutes_played=900.0)

        idx_low = compute_attacking_involvement_indices(row_low_goals, "FWD", POSITION_AVG, WEIGHTS)
        idx_high = compute_attacking_involvement_indices(row_high_goals, "FWD", POSITION_AVG, WEIGHTS)

        scaling_low = combine_involvement_index(idx_low["shot_on_target"], idx_low["assist"])
        scaling_high = combine_involvement_index(idx_high["shot_on_target"], idx_high["assist"])
        self.assertAlmostEqual(scaling_low, scaling_high, places=9)

    def test_clean_sheet_out_of_scope_returns_none(self):
        row = make_row(goals=5.0, minutes_played=900.0)
        self.assertIsNone(compute_module_rate_fantasy_influence("clean_sheet_60min", row, "FWD", POSITION_AVG, WEIGHTS))

    def test_missing_shot_on_target_average_falls_back_not_fabricated(self):
        row = make_row(goals=12.0, assists=6.0, shots_on_target=36.0, minutes_played=900.0)
        avg_no_sot = {"FWD": {"goals": 0.4, "assists": 0.2, "shots_on_target": 0.0}}
        fi_rate = compute_module_rate_fantasy_influence("goal", row, "FWD", avg_no_sot, WEIGHTS)
        # Should still return a number (falls back to assist involvement alone), not None/crash.
        self.assertIsNotNone(fi_rate)


if __name__ == "__main__":
    unittest.main(verbosity=2)
