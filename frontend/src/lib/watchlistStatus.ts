import type { FixtureRun } from "./fixtureRuns";

export type WatchlistStatus = "early_watch" | "approaching" | "act_now" | "active" | "expired" | "avoid";

export const WATCHLIST_STATUS_DISPLAY: Record<WatchlistStatus, { label: string; tone: "green" | "amber" | "red" | "gray" }> = {
  act_now: { label: "Act Now", tone: "green" },
  active: { label: "Active", tone: "green" },
  approaching: { label: "Approaching", tone: "amber" },
  early_watch: { label: "Early Watch", tone: "gray" },
  expired: { label: "Expired", tone: "gray" },
  avoid: { label: "Avoid", tone: "red" },
};

/**
 * Maps a watchlist entry's nearest good/bad fixture runs to one of the
 * spec's 6 statuses, evaluated in priority order - a currently-active or
 * imminent BAD run always wins over any good-run framing, since a player
 * can't simultaneously be a buy target and heading into a rough patch.
 *
 * Concrete gameweek-distance thresholds: Act Now = a good run starts
 * within 0-1 gameweeks, Approaching = 2-5 gameweeks away, Early Watch =
 * further than that or nothing detected yet, Active = currently inside
 * the good run, Expired = a good run happened and ended with nothing new
 * queued, Avoid = inside or <=1 gameweek from a bad run.
 */
export function computeWatchlistStatus({
  planningGameweek,
  nearestBadRun,
  nearestGoodRun,
  lastGoodRunEndGameweek,
}: {
  planningGameweek: number | null;
  nearestBadRun: FixtureRun | null;
  nearestGoodRun: FixtureRun | null;
  lastGoodRunEndGameweek: number | null;
}): WatchlistStatus {
  if (planningGameweek === null) return "early_watch";

  if (nearestBadRun && planningGameweek >= nearestBadRun.startGameweek - 1 && planningGameweek <= nearestBadRun.endGameweek) {
    return "avoid";
  }
  if (nearestGoodRun && planningGameweek >= nearestGoodRun.startGameweek && planningGameweek <= nearestGoodRun.endGameweek) {
    return "active";
  }
  if (lastGoodRunEndGameweek !== null && lastGoodRunEndGameweek < planningGameweek && !nearestGoodRun) {
    return "expired";
  }
  if (nearestGoodRun) {
    const distance = nearestGoodRun.startGameweek - planningGameweek;
    if (distance <= 1) return "act_now";
    if (distance <= 5) return "approaching";
    return "early_watch";
  }
  return "early_watch";
}
