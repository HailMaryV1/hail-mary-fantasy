import { LINEUP_SECURITY_SCORES, DEFAULT_SECURITY_SCORE, resolveStatusBadge } from "./playerStatus";
import type { TeamFixtureRating } from "./fixtureSwing";

export type SquadHealthPlayer = {
  gamePlayerId: number;
  fullName: string;
  position: "GK" | "DEF" | "MID" | "FWD";
  teamName: string;
  price: number;
  score: number | null; // current single-GW Hail Mary Score
  lineup: string | null;
  status: string | null;
  isStarting: boolean;
};

export type SquadHealthReport = {
  rating: number; // 0-100
  strengths: string[];
  weaknesses: string[];
  priorityAreas: { position: string; reason: string }[];
};

const POSITIONS = ["GK", "DEF", "MID", "FWD"] as const;

/**
 * "Quality relative to the pool" - a starter scoring exactly at their
 * position's pool average is treated as fully healthy (ratio 1.0 -> 50),
 * not as mediocre.
 */
function qualityRatio(score: number | null, positionAverage: number): number {
  if (score == null || positionAverage <= 0) return 1;
  return score / positionAverage;
}

/**
 * Builds a real, data-derived squad assessment - every bullet below only
 * fires when the underlying numbers actually support it, so a strong
 * squad can legitimately come back with zero weaknesses rather than
 * padded criticism.
 */
export function assessSquadHealth(
  players: SquadHealthPlayer[],
  positionAverages: Record<string, number>,
  maxPerClub: number | null,
  fixtureRatingsByTeam: Map<string, TeamFixtureRating>,
  horizonGameweeks: number
): SquadHealthReport {
  const starters = players.filter((p) => p.isStarting);
  const bench = players.filter((p) => !p.isStarting);

  const starterRatios = starters.map((p) => qualityRatio(p.score, positionAverages[p.position] ?? 0));
  const avgStarterRatio = starterRatios.length > 0 ? starterRatios.reduce((a, b) => a + b, 0) / starterRatios.length : 1;
  // positionAverages is computed across the WHOLE pool (backups and
  // fringe players included), so a deliberately-selected starting XI
  // routinely scores well above it - a *60 scale (rather than *100) keeps
  // "great" and "exceptional" squads distinguishable instead of every
  // decent squad saturating at 100.
  const rating = Math.max(0, Math.min(100, Math.round(50 + (avgStarterRatio - 1) * 60)));

  const strengths: string[] = [];
  const weaknesses: string[] = [];

  // Per-position starter health, used both for strengths/weaknesses and
  // for ranking priority areas below.
  const positionHealth = new Map<string, { avgRatio: number; avgSecurity: number; count: number }>();
  for (const pos of POSITIONS) {
    const posStarters = starters.filter((p) => p.position === pos);
    if (posStarters.length === 0) continue;
    const avgRatio = posStarters.reduce((sum, p) => sum + qualityRatio(p.score, positionAverages[pos] ?? 0), 0) / posStarters.length;
    const avgSecurity =
      posStarters.reduce((sum, p) => sum + (LINEUP_SECURITY_SCORES[p.lineup ?? ""] ?? DEFAULT_SECURITY_SCORE), 0) / posStarters.length;
    positionHealth.set(pos, { avgRatio, avgSecurity, count: posStarters.length });
  }

  for (const [pos, health] of positionHealth) {
    if (health.avgRatio >= 1.15) {
      strengths.push(`Strong ${pos} options - projected well above the pool average at that position.`);
    }
    if (health.avgRatio <= 0.85) {
      weaknesses.push(`${pos} is underperforming relative to the rest of the pool right now.`);
    }
  }

  // Fixture-swing-aware strengths/weaknesses, using each starting
  // player's own club rating rather than a generic league view.
  const teamsInSquad = new Set(starters.map((p) => p.teamName));
  const improvingTeams: string[] = [];
  const decliningTeams: string[] = [];
  for (const teamName of teamsInSquad) {
    const rating2 = fixtureRatingsByTeam.get(teamName);
    if (!rating2 || rating2.startsInGameweek == null || rating2.startsInGameweek > horizonGameweeks + 1) continue;
    if (rating2.swingDirection === "improving") improvingTeams.push(teamName);
    if (rating2.swingDirection === "declining") decliningTeams.push(teamName);
  }
  if (improvingTeams.length > 0) {
    strengths.push(`${improvingTeams.join(", ")} enter${improvingTeams.length === 1 ? "s" : ""} a favourable fixture run within your planning window.`);
  }
  if (decliningTeams.length > 0) {
    weaknesses.push(`${decliningTeams.join(", ")} face${decliningTeams.length === 1 ? "s" : ""} a tougher fixture run soon - assets there may need reviewing.`);
  }

  // Captaincy reliability - a genuine strength only if your best scorer
  // also has secure minutes.
  const topStarter = starters.slice().sort((a, b) => (b.score ?? 0) - (a.score ?? 0))[0];
  if (topStarter && (LINEUP_SECURITY_SCORES[topStarter.lineup ?? ""] ?? DEFAULT_SECURITY_SCORE) >= 0.9) {
    strengths.push(`${topStarter.fullName} looks like a reliable captaincy option with secure starting minutes.`);
  }

  // Bench reliability.
  const shakyBench = bench.filter((p) => (LINEUP_SECURITY_SCORES[p.lineup ?? ""] ?? DEFAULT_SECURITY_SCORE) < 0.5);
  if (shakyBench.length > 0) {
    weaknesses.push(`${shakyBench.length} bench player${shakyBench.length === 1 ? "" : "s"} unlikely to start if called upon.`);
  }

  // Club concentration.
  if (maxPerClub) {
    const clubCounts = new Map<string, number>();
    players.forEach((p) => clubCounts.set(p.teamName, (clubCounts.get(p.teamName) ?? 0) + 1));
    for (const [team, count] of clubCounts) {
      if (count >= maxPerClub) {
        weaknesses.push(`Squad is at the ${team} club limit (${count}/${maxPerClub}) - no room to add more from there.`);
      }
    }
  }

  // Expensive underperformers - top quartile price among the squad but
  // below-average output for their position.
  const sortedByPrice = players.slice().sort((a, b) => b.price - a.price);
  const priceThreshold = sortedByPrice[Math.max(0, Math.floor(players.length / 4) - 1)]?.price ?? Infinity;
  for (const p of players) {
    if (p.price >= priceThreshold && qualityRatio(p.score, positionAverages[p.position] ?? 0) < 0.9) {
      weaknesses.push(`${p.fullName} is expensive relative to projected output right now.`);
    }
  }

  // Availability.
  for (const p of starters) {
    const badge = resolveStatusBadge(p.lineup, p.status);
    if (badge && badge.tone === "red") {
      weaknesses.push(`${p.fullName} is currently unavailable (${badge.label}).`);
    }
  }

  const priorityAreas = Array.from(positionHealth.entries())
    .map(([position, health]) => {
      const declining = starters.some((p) => p.position === position && decliningTeams.includes(p.teamName));
      const needsAttention = 1 - health.avgRatio + (1 - health.avgSecurity) * 0.5 + (declining ? 0.3 : 0);
      let reason = "Performing as expected.";
      if (health.avgRatio < 0.9) reason = "Below-average projected output for this position.";
      else if (health.avgSecurity < 0.75) reason = "Minutes security is a concern.";
      else if (declining) reason = "Facing a tougher fixture run soon.";
      return { position, reason, needsAttention };
    })
    .sort((a, b) => b.needsAttention - a.needsAttention)
    .filter((p) => p.needsAttention > 0.1)
    .slice(0, 3)
    .map(({ position, reason }) => ({ position, reason }));

  return {
    rating,
    strengths: strengths.slice(0, 4),
    weaknesses: weaknesses.slice(0, 5),
    priorityAreas,
  };
}
