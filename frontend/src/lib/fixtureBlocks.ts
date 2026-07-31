// The one shared "fixture block" calculation - composes the existing
// run-detector (fixtureRuns.ts) rather than re-implementing streak
// detection. A block is a real detected run of 2+ consecutive
// favourable-or-difficult gameweeks (the only caller passing
// minLength: 2 - every other existing consumer of detectFixtureRuns
// keeps its own default of 3, untouched), with attack and clean-sheet
// outlook assessed separately across that same window rather than only
// the blended view.
import { computeTeamGameweekRatios, detectFixtureRuns, type FixtureDifficultyRow } from "./fixtureRuns";

const BLOCK_MIN_LENGTH = 2;
const GOOD_THRESHOLD = 1.15;
const BAD_THRESHOLD = 0.85;

type BlockMetricClassification = "good" | "bad" | "neutral";

function classify(ratio: number): BlockMetricClassification {
  if (ratio >= GOOD_THRESHOLD) return "good";
  if (ratio <= BAD_THRESHOLD) return "bad";
  return "neutral";
}

export type FixtureBlock = {
  teamName: string;
  kind: "good" | "bad";
  startGameweek: number;
  endGameweek: number;
  length: number;
  // Averaged across the SAME window as startGameweek..endGameweek (not
  // independently-detected runs of their own, which could be a
  // different length/position) - so every block always has a real
  // attack/clean-sheet read for the exact window it covers, never null
  // just because that dimension alone didn't happen to also qualify as
  // its own 2+ run.
  attack: { kind: BlockMetricClassification; avgScore: number } | null;
  cleanSheet: { kind: BlockMetricClassification; avgScore: number } | null;
};

export function detectFixtureBlocks(rows: FixtureDifficultyRow[]): FixtureBlock[] {
  const combinedRuns = detectFixtureRuns(rows, { metric: "combined", minLength: BLOCK_MIN_LENGTH });

  const ratiosByTeam = new Map<string, ReturnType<typeof computeTeamGameweekRatios>>();
  for (const r of computeTeamGameweekRatios(rows)) {
    const list = ratiosByTeam.get(r.teamName) ?? [];
    list.push(r);
    ratiosByTeam.set(r.teamName, list);
  }

  function averageOverWindow(teamName: string, start: number, end: number, field: "attackRatio" | "cleanSheetRatio") {
    const points = (ratiosByTeam.get(teamName) ?? []).filter((p) => p.gameweek >= start && p.gameweek <= end);
    const vals = points.map((p) => p[field]).filter((v): v is number => v != null);
    return vals.length > 0 ? vals.reduce((a, b) => a + b, 0) / vals.length : null;
  }

  return combinedRuns.map((run) => {
    const attackAvg = averageOverWindow(run.teamName, run.startGameweek, run.endGameweek, "attackRatio");
    const cleanSheetAvg = averageOverWindow(run.teamName, run.startGameweek, run.endGameweek, "cleanSheetRatio");
    return {
      teamName: run.teamName,
      kind: run.kind,
      startGameweek: run.startGameweek,
      endGameweek: run.endGameweek,
      length: run.length,
      attack: attackAvg != null ? { kind: classify(attackAvg), avgScore: attackAvg } : null,
      cleanSheet: cleanSheetAvg != null ? { kind: classify(cleanSheetAvg), avgScore: cleanSheetAvg } : null,
    };
  });
}
