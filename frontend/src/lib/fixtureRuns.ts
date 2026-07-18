// Same classification thresholds as squads/[id]/analysis/page.tsx's
// classify() (>=1.15 good, <=0.85 bad) - but NOT the same neutral
// baseline. That page compares a squad's next 3 fixtures against a
// fixed league-average win probability (1/3 attack, 0.5 clean sheet),
// which is the right question for "are these 3 fixtures objectively
// favourable." It's the wrong question here: a genuinely dominant team
// (e.g. Arsenal) has an above-league-average win probability in nearly
// every fixture, even away at Man City or Man Utd - so a fixed baseline
// never dips into "tough" for them, and their whole season reads as one
// giant good run. What actually breaks a run is a fixture that's hard
// *for that specific team*, so each team is compared against its own
// average difficulty across its own fixture list instead.
const MIN_RUN_LENGTH = 3;

export type FixtureDifficultyRow = {
  teamName: string;
  gameweek: number;
  attackScore: number | null;
  cleanSheetScore: number | null;
};

export type FixtureRun = {
  teamName: string;
  kind: "good" | "bad";
  startGameweek: number;
  endGameweek: number;
  length: number;
  avgScore: number;
};

type Classification = "good" | "bad" | "neutral";

function classifyRatio(ratio: number): Classification {
  if (ratio >= 1.15) return "good";
  if (ratio <= 0.85) return "bad";
  return "neutral";
}

/**
 * Scans every team's ordered gameweek sequence for maximal contiguous
 * stretches (3+) of the same good/bad classification. A double-gameweek
 * (2+ input rows sharing a team+gameweek) is averaged into one point
 * before classifying, so a run always describes real gameweek span, not
 * raw fixture count. A missing gameweek in the sequence, a classification
 * change, or a gameweek with no odds posted yet (neutral) all break a run.
 */
export function detectFixtureRuns(rows: FixtureDifficultyRow[]): FixtureRun[] {
  const byTeam = new Map<string, Map<number, { attack: number[]; cleanSheet: number[] }>>();

  for (const row of rows) {
    let gwMap = byTeam.get(row.teamName);
    if (!gwMap) {
      gwMap = new Map();
      byTeam.set(row.teamName, gwMap);
    }
    let bucket = gwMap.get(row.gameweek);
    if (!bucket) {
      bucket = { attack: [], cleanSheet: [] };
      gwMap.set(row.gameweek, bucket);
    }
    if (row.attackScore != null) bucket.attack.push(row.attackScore);
    if (row.cleanSheetScore != null) bucket.cleanSheet.push(row.cleanSheetScore);
  }

  const runs: FixtureRun[] = [];

  for (const [teamName, gwMap] of byTeam) {
    const gameweeks = Array.from(gwMap.keys()).sort((a, b) => a - b);

    // This team's own average difficulty across its whole fixture list -
    // the baseline every individual gameweek gets compared against.
    let attackSum = 0;
    let attackCount = 0;
    let cleanSheetSum = 0;
    let cleanSheetCount = 0;
    for (const bucket of gwMap.values()) {
      for (const a of bucket.attack) {
        attackSum += a;
        attackCount += 1;
      }
      for (const c of bucket.cleanSheet) {
        cleanSheetSum += c;
        cleanSheetCount += 1;
      }
    }
    const baselineAttack = attackCount > 0 ? attackSum / attackCount : null;
    const baselineCleanSheet = cleanSheetCount > 0 ? cleanSheetSum / cleanSheetCount : null;

    const points = gameweeks.map((gw) => {
      const bucket = gwMap.get(gw)!;
      const ratios: number[] = [];
      if (bucket.attack.length > 0 && baselineAttack) {
        ratios.push((bucket.attack.reduce((a, b) => a + b, 0) / bucket.attack.length) / baselineAttack);
      }
      if (bucket.cleanSheet.length > 0 && baselineCleanSheet) {
        ratios.push((bucket.cleanSheet.reduce((a, b) => a + b, 0) / bucket.cleanSheet.length) / baselineCleanSheet);
      }
      if (ratios.length === 0) return { gameweek: gw, classification: "neutral" as Classification, ratio: null as number | null };
      const ratio = ratios.reduce((a, b) => a + b, 0) / ratios.length;
      return { gameweek: gw, classification: classifyRatio(ratio), ratio };
    });

    let streakStart = 0;
    for (let i = 1; i <= points.length; i++) {
      const brokeStreak =
        i === points.length ||
        points[i].classification !== points[streakStart].classification ||
        points[i].gameweek !== points[i - 1].gameweek + 1;

      if (brokeStreak) {
        const streak = points.slice(streakStart, i);
        const kind = streak[0].classification;
        if ((kind === "good" || kind === "bad") && streak.length >= MIN_RUN_LENGTH) {
          const ratios = streak.map((p) => p.ratio).filter((r): r is number => r != null);
          runs.push({
            teamName,
            kind,
            startGameweek: streak[0].gameweek,
            endGameweek: streak[streak.length - 1].gameweek,
            length: streak.length,
            avgScore: ratios.reduce((a, b) => a + b, 0) / ratios.length,
          });
        }
        streakStart = i;
      }
    }
  }

  return runs;
}
