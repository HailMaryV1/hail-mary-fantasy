import { INJURY_AVAILABILITY_SCORES } from "./playerStatus";

export type WatchlistAlert = {
  id: string;
  tone: "good" | "bad" | "info";
  message: string;
  gamePlayerId: number;
};

export type WatchlistEntryWithComputedState = {
  entryId: number;
  gamePlayerId: number;
  fullName: string;
  teamName: string;
  currentScore: number | null;
  lastSeenScore: number | null;
  status: string | null;
  lastSeenStatus: string | null;
  swingKind: "good" | "bad" | null; // this player's team's nearest detected run kind, right now
  lastSeenSwingKind: string | null;
  nearestGoodRunStartsInGameweeks: number | null; // startGameweek - planningGameweek, null if no good run detected
};

// A raw Hail Mary Score move smaller than this is noise (rounding,
// tiny odds movement) - only genuinely meaningful jumps get surfaced.
const SCORE_INCREASE_THRESHOLD = 0.5;

/**
 * Pure - compares each watchlist entry's freshly-computed state against
 * its last_seen_* snapshot (set by the previous page load) to produce
 * delta-based alerts, plus one state-based alert ("fixtures improve next
 * week"). Computed on every Watchlist page render - no new cron/background
 * job. The caller is responsible for persisting the new snapshot back via
 * watchlist/actions.ts's reconcileWatchlistSnapshot after reading this
 * function's output, so the same change isn't re-alerted on the next load.
 */
export function computeWatchlistAlerts(entries: WatchlistEntryWithComputedState[]): WatchlistAlert[] {
  const alerts: WatchlistAlert[] = [];
  const improvingTeamsAlerted = new Set<string>();

  for (const e of entries) {
    if (e.lastSeenScore != null && e.currentScore != null && e.currentScore > e.lastSeenScore + SCORE_INCREASE_THRESHOLD) {
      alerts.push({
        id: `${e.entryId}-score`,
        tone: "good",
        message: `${e.fullName}'s Hail Mary Score has increased (${e.lastSeenScore.toFixed(1)} → ${e.currentScore.toFixed(1)}).`,
        gamePlayerId: e.gamePlayerId,
      });
    }

    // One alert per team, not per watched player at that team - watching
    // three Chelsea players shouldn't produce three identical alerts.
    if (e.nearestGoodRunStartsInGameweeks === 1 && !improvingTeamsAlerted.has(e.teamName)) {
      alerts.push({
        id: `${e.entryId}-fixtures-improve`,
        tone: "good",
        message: `${e.teamName} fixtures improve next week.`,
        gamePlayerId: e.gamePlayerId,
      });
      improvingTeamsAlerted.add(e.teamName);
    }

    if (e.lastSeenSwingKind !== "bad" && e.swingKind === "bad") {
      alerts.push({
        id: `${e.entryId}-bad-run`,
        tone: "bad",
        message: `${e.fullName} has entered a difficult fixture run.`,
        gamePlayerId: e.gamePlayerId,
      });
    }

    const wasAvailable = e.lastSeenStatus == null || (INJURY_AVAILABILITY_SCORES[e.lastSeenStatus] ?? 1) !== 0;
    const isUnavailable = e.status != null && INJURY_AVAILABILITY_SCORES[e.status] === 0;
    if (wasAvailable && isUnavailable) {
      alerts.push({
        id: `${e.entryId}-injury`,
        tone: "bad",
        message: `${e.fullName} has become unavailable through injury.`,
        gamePlayerId: e.gamePlayerId,
      });
    }
  }

  return alerts;
}
