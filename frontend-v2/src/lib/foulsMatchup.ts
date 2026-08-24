/**
 * foulsMatchup.ts
 * ---------------------------------------------------------------------------
 * Turns two independently-priced fouls boards plus the two posted formations
 * into a set of hard consistency constraints, and reports where the bookmaker
 * has broken them.
 *
 * The identity everything here rests on: a foul is a transaction. One player
 * commits it, one player (usually) suffers it. So for any match,
 *
 *     fouls committed by team A  ==  fouls suffered by team B
 *
 * up to ATTRIBUTION_RATE, the share of fouls that have no fouled player at all
 * (handball, dissent, dangerous play, encroachment). The bookmaker prices
 * roughly 200 rungs across the two boards independently and has no mechanism
 * forcing them to respect that identity. When they drift apart, one side of
 * the board is soft - and the drift is measurable with no data of our own.
 *
 * Two levels of the same test, weakest to strongest:
 *
 *   teamConservation()      - one constraint per team. Prior-free: it needs
 *                             only the two boards and the attribution rate.
 *   duelReconciliation()    - a dozen constraints, one per zone matchup, built
 *                             from the formations. Sharper, because a board can
 *                             satisfy the match total while being badly wrong
 *                             flank by flank, but it does lean on a structural
 *                             prior for who duels whom (see DUEL_LINE_WEIGHTS).
 *
 * IMPORTANT SCOPE NOTE. Boards price starting outfielders only - no keepers, no
 * substitutes - so the sum over a board undershoots the team's true match total
 * by whatever subs and the keeper contribute. That bias lands on BOTH boards at
 * once, so the RATIO between them is robust and is what the conservation test
 * uses. The absolute implied match total is reported too, but as a soft
 * diagnostic only, never as an edge.
 */

import type { BoardFit, LadderFit, FoulsMarket } from "./foulsEdge";
import { applyMargin, nbSurvival, fairPrice } from "./foulsEdge";

/**
 * Share of fouls that can be attributed to a specific fouled player. The
 * remainder - handball, dissent, dangerous play, encroachment, foul throws -
 * are committed by someone but suffered by nobody, so they appear on the
 * committed board and never on the to-be-fouled board.
 *
 * MEASURED, not assumed: 91,645 fouls drawn against 95,023 fouls committed
 * across 6,614 player-seasons (migration 0142). It previously sat at 0.90 on
 * nothing more than judgement, and that mattered - the conservation test scales
 * one board by this number before comparing it to the other, so a value six
 * points too low inflated the apparent gap and some of the "cross-board edge"
 * this tool reported was really just this constant.
 *
 * Still exposed as an option on every entry point, since it is the single most
 * influential number in this file.
 */
export const ATTRIBUTION_RATE = 0.964;

/* ========================================================================== *
 * Formation
 * ========================================================================== */

export type Role = "GK" | "DEF" | "MID" | "FWD";
/** Flank as the player would be described - a left-back is "L". */
export type Flank = "L" | "C" | "R";

export type FormationSlot = {
  name: string;
  shirt?: number | null;
  /** SportMonks player id, when the slot came from a real lineup. */
  playerId?: number | null;
  team: string;
  role: Role;
  flank: Flank;
  /**
   * Position across the pitch, 0 to 1, on an ABSOLUTE axis shared by both
   * teams - so two players with the same value are on the same touchline and
   * therefore face each other, regardless of which side they play for.
   *
   * Supplied by SportMonks lineups (see sportmonksFouls.ts, which derives it
   * from the formation grid). Preferred over `flank` whenever present: it is
   * continuous, so a duel fades with distance instead of jumping between three
   * buckets, and it needs no home/away flipping to line the teams up.
   */
  lateral?: number;
};

export type Formation = {
  team: string;
  /** Free text, e.g. "4-2-3-1". Recorded for display; not parsed. */
  shape: string;
  slots: FormationSlot[];
};

/**
 * Absolute touchline a slot occupies, so the two teams can be matched against
 * each other. Both teams call their own left "L", but those are opposite
 * touchlines - the home left-back marks the away right-winger. Anchoring to a
 * fixed side ("N"/"S") is what lets the duel matrix pair them up correctly.
 */
type AbsoluteSide = "N" | "C" | "S";

function absoluteSide(flank: Flank, isHome: boolean): AbsoluteSide {
  if (flank === "C") return "C";
  if (isHome) return flank === "L" ? "N" : "S";
  return flank === "L" ? "S" : "N";
}

/* ========================================================================== *
 * Duel weighting
 * ========================================================================== */

/**
 * How much of a foul-generating duel two players in these roles have with each
 * other. Defender-versus-forward is the archetypal foul-producing contest;
 * two forwards from opposing teams barely interact. These are structural
 * priors from how football is played, not fitted coefficients - they shape
 * which pairings the duel test compares, and are deliberately blunt.
 */
const DUEL_LINE_WEIGHTS: Record<string, number> = {
  "DEF|FWD": 1.0,
  "FWD|DEF": 1.0,
  "MID|MID": 1.0,
  "DEF|MID": 0.7,
  "MID|DEF": 0.7,
  "MID|FWD": 0.75,
  "FWD|MID": 0.75,
  "DEF|DEF": 0.15,
  "FWD|FWD": 0.15,
};

/** Lateral overlap: same touchline duels constantly, opposite touchlines rarely. */
function sideWeight(a: AbsoluteSide, b: AbsoluteSide): number {
  if (a === b) return 1.0;
  if (a === "C" || b === "C") return 0.45;
  return 0.08; // opposite touchlines - a left-back and the far-side left-back
}

/**
 * Continuous lateral overlap. A Gaussian in absolute pitch position: players on
 * the same touchline duel constantly, and the weight decays smoothly with the
 * distance between them rather than falling off a cliff at a bucket boundary.
 * The 0.34 width means a full-back and the opposite full-back retain about 1%
 * of the weight of a direct matchup, which is roughly right - they do
 * occasionally meet.
 */
function lateralWeight(a: number, b: number): number {
  const d = (a - b) / 0.34;
  return Math.exp(-d * d);
}

export function duelWeight(a: FormationSlot, b: FormationSlot, aIsHome: boolean): number {
  if (a.role === "GK" || b.role === "GK") return 0;
  const line = DUEL_LINE_WEIGHTS[`${a.role}|${b.role}`] ?? 0.4;
  // Real lineup coordinates when we have them, bucketed flanks when we do not.
  const lateral =
    a.lateral !== undefined && b.lateral !== undefined
      ? lateralWeight(a.lateral, b.lateral)
      : sideWeight(absoluteSide(a.flank, aIsHome), absoluteSide(b.flank, !aIsHome));
  return line * lateral;
}

/**
 * Strip case, accents and punctuation so names from two different feeds line
 * up. Only ever used to match a board name against a lineup name within one
 * fixture, so it can afford to be this aggressive.
 */
function normaliseName(s: string): string {
  return s
    .toLowerCase()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^a-z ]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

/* ========================================================================== *
 * Level 1: team conservation (prior-free)
 * ========================================================================== */

export type TeamConservation = {
  team: string;
  opponent: string;
  /** Sum of market-implied expected fouls committed by this team's priced XI. */
  committedTotal: number;
  /** Sum of market-implied expected fouls suffered by the opponent's priced XI. */
  opponentSufferedTotal: number;
  /** committedTotal * ATTRIBUTION_RATE - what the committed board says should land. */
  expectedSuffered: number;
  /**
   * opponentSufferedTotal / expectedSuffered. Above 1 means the to-be-fouled
   * board is pricing more fouls than the committed board can supply, so the
   * to-be-fouled side is short and the committed side is the value side.
   */
  ratio: number;
  /** Signed foul-count gap between the two boards. */
  gap: number;
};

function sumMu(fits: LadderFit[], team: string): number {
  return fits.filter((f) => f.team === team).reduce((acc, f) => acc + f.mu, 0);
}

export function teamConservation(
  fit: BoardFit,
  home: string,
  away: string,
  attribution: number = ATTRIBUTION_RATE,
): TeamConservation[] {
  return [
    [home, away] as const,
    [away, home] as const,
  ].map(([team, opponent]) => {
    const committedTotal = sumMu(fit.committed, team);
    const opponentSufferedTotal = sumMu(fit.toBeFouled, opponent);
    const expectedSuffered = committedTotal * attribution;
    return {
      team,
      opponent,
      committedTotal,
      opponentSufferedTotal,
      expectedSuffered,
      ratio: expectedSuffered > 0 ? opponentSufferedTotal / expectedSuffered : NaN,
      gap: opponentSufferedTotal - expectedSuffered,
    };
  });
}

/* ========================================================================== *
 * Level 2: duel reconciliation
 * ========================================================================== */

export type FoulFlow = {
  committer: string;
  sufferer: string;
  fouls: number;
};

export type DuelDiagnostic = {
  player: string;
  team: string;
  market: FoulsMarket;
  /** What the market's own ladder implies for this player. */
  marketMu: number;
  /**
   * What the duel structure implies, given the OTHER board's totals: the fouls
   * the opposing XI is priced to commit, allocated across this team by who
   * actually duels whom.
   */
  structuralMu: number;
  /** marketMu / structuralMu. Above 1 = market prices this player higher than the duel map supports. */
  ratio: number;
  /** Flow rows feeding this player, largest first - the "where the clash is" view. */
  topFlows: FoulFlow[];
};

type Matrix = number[][];

/**
 * Iterative proportional fitting. Finds the maximum-entropy foul-flow matrix
 * whose row sums match what each committer is priced to commit and whose
 * column sums match what each opponent is priced to suffer, while staying as
 * close as possible in shape to the structural duel weights.
 *
 * IPF is the right tool because the two boards give exactly the two margins of
 * a contingency table and the formation gives its shape. Where it has to
 * stretch hardest to satisfy both margins is precisely where the bookmaker's
 * two boards disagree about the same fouls.
 */
function ipf(seed: Matrix, rowTargets: number[], colTargets: number[], iters = 200): Matrix {
  const rows = seed.length;
  const cols = seed[0]?.length ?? 0;
  const m: Matrix = seed.map((r) => r.slice());

  for (let it = 0; it < iters; it++) {
    for (let i = 0; i < rows; i++) {
      const s = m[i].reduce((a, b) => a + b, 0);
      if (s > 1e-12) {
        const f = rowTargets[i] / s;
        for (let j = 0; j < cols; j++) m[i][j] *= f;
      }
    }
    for (let j = 0; j < cols; j++) {
      let s = 0;
      for (let i = 0; i < rows; i++) s += m[i][j];
      if (s > 1e-12) {
        const f = colTargets[j] / s;
        for (let i = 0; i < rows; i++) m[i][j] *= f;
      }
    }
  }
  return m;
}

export type DuelReconciliation = {
  /** One direction of play: `committerTeam` fouling `suffererTeam`. */
  committerTeam: string;
  suffererTeam: string;
  flows: FoulFlow[];
  /** Per-player read on the to-be-fouled board for the suffering team. */
  sufferDiagnostics: DuelDiagnostic[];
  /** Per-player read on the committed board for the committing team. */
  commitDiagnostics: DuelDiagnostic[];
};

/**
 * For one direction of fouling, build the duel matrix, allocate the committed
 * board's fouls across it purely structurally, and compare the result with what
 * the to-be-fouled board independently says. Then run IPF to get the flow
 * matrix that satisfies both boards, which is what powers the "where the
 * clashes occur" view.
 */
function reconcileDirection(
  committers: LadderFit[],
  sufferers: LadderFit[],
  committerSlots: FormationSlot[],
  suffererSlots: FormationSlot[],
  committerIsHome: boolean,
  attribution: number,
): DuelReconciliation {
  // Accent-insensitive, because the two feeds disagree about diacritics: the
  // odds board sends "Romeo Lavia" and "Gonzalo Garcia" while the lineup sends
  // "Romeo Lavia" with an accent and "Gonzalo Garcia" with one too. Comparing
  // raw strings dropped every accented player out of the duel matrix, and
  // because a player with no duel cells simply generates no fouls, the
  // simulation quietly priced Lavia's 2+ at 1% against a ladder saying 48%.
  // Silent, and wrong in the direction that makes a bet look unbackable.
  const slotOf = (slots: FormationSlot[], name: string) => {
    const target = normaliseName(name);
    return slots.find((s) => normaliseName(s.name) === target);
  };

  const cRows = committers.filter((c) => slotOf(committerSlots, c.name));
  const sCols = sufferers.filter((s) => slotOf(suffererSlots, s.name));

  const W: Matrix = cRows.map((c) =>
    sCols.map((s) => {
      const cs = slotOf(committerSlots, c.name)!;
      const ss = slotOf(suffererSlots, s.name)!;
      return duelWeight(cs, ss, committerIsHome);
    }),
  );

  // Structural allocation: spread each committer's priced fouls over the
  // players they actually duel, weighting by how receptive the market says
  // each opponent is (their own to-be-fouled mu). Using the market's own
  // receptivity avoids inventing a "who gets fouled" prior of our own - the
  // only prior here is WHO MEETS WHOM, which comes from the formation.
  const structural = new Array(sCols.length).fill(0);
  cRows.forEach((c, i) => {
    const supply = c.mu * attribution;
    let denom = 0;
    for (let j = 0; j < sCols.length; j++) denom += W[i][j] * sCols[j].mu;
    if (denom <= 1e-12) return;
    for (let j = 0; j < sCols.length; j++) {
      structural[j] += (supply * W[i][j] * sCols[j].mu) / denom;
    }
  });

  // IPF onto both margins, scaling the suffer margin so the two totals agree
  // (the level-1 gap is reported separately; here we want the shape, not the
  // level, so forcing agreement is correct rather than hiding anything).
  const rowTargets = cRows.map((c) => c.mu * attribution);
  const rowSum = rowTargets.reduce((a, b) => a + b, 0);
  const rawCol = sCols.map((s) => s.mu);
  const colSum = rawCol.reduce((a, b) => a + b, 0);
  const colTargets = colSum > 0 ? rawCol.map((v) => (v * rowSum) / colSum) : rawCol;

  const seed: Matrix = W.map((row, i) =>
    row.map((w, j) => Math.max(1e-9, w * Math.max(1e-9, sCols[j].mu) * Math.max(1e-9, cRows[i].mu))),
  );
  const F = ipf(seed, rowTargets, colTargets);

  const flows: FoulFlow[] = [];
  cRows.forEach((c, i) =>
    sCols.forEach((s, j) => {
      // Threshold is deliberately tiny: these cells are the simulation's entire
      // source of fouls, so anything discarded here is mass a player never gets
      // back. Display trims to the top rows separately.
      if (F[i][j] > 1e-4) flows.push({ committer: c.name, sufferer: s.name, fouls: F[i][j] });
    }),
  );
  flows.sort((a, b) => b.fouls - a.fouls);

  const sufferDiagnostics: DuelDiagnostic[] = sCols.map((s, j) => ({
    player: s.name,
    team: s.team,
    market: "toBeFouled" as FoulsMarket,
    marketMu: s.mu,
    structuralMu: structural[j],
    ratio: structural[j] > 1e-9 ? s.mu / structural[j] : NaN,
    topFlows: flows.filter((f) => f.sufferer === s.name).slice(0, 3),
  }));

  const commitDiagnostics: DuelDiagnostic[] = cRows.map((c) => ({
    player: c.name,
    team: c.team,
    market: "committed" as FoulsMarket,
    marketMu: c.mu,
    structuralMu: c.mu, // committed board is the row margin here, by construction
    ratio: 1,
    topFlows: flows.filter((f) => f.committer === c.name).slice(0, 3),
  }));

  return {
    committerTeam: cRows[0]?.team ?? "",
    suffererTeam: sCols[0]?.team ?? "",
    flows,
    sufferDiagnostics,
    commitDiagnostics,
  };
}

export function duelReconciliation(
  fit: BoardFit,
  homeFormation: Formation,
  awayFormation: Formation,
  attribution: number = ATTRIBUTION_RATE,
): DuelReconciliation[] {
  const home = homeFormation.team;
  const away = awayFormation.team;
  return [
    reconcileDirection(
      fit.committed.filter((f) => f.team === home),
      fit.toBeFouled.filter((f) => f.team === away),
      homeFormation.slots,
      awayFormation.slots,
      true,
      attribution,
    ),
    reconcileDirection(
      fit.committed.filter((f) => f.team === away),
      fit.toBeFouled.filter((f) => f.team === home),
      awayFormation.slots,
      homeFormation.slots,
      false,
      attribution,
    ),
  ];
}

/* ========================================================================== *
 * Level reconciliation
 * ========================================================================== */

/**
 * Pull the two boards toward each other so they agree on HOW MANY fouls the
 * match contains, before anything asks which player they belong to.
 *
 * Order matters here and getting it wrong makes the duel test useless. Run the
 * duel comparison on raw market numbers and every single player comes back
 * "market high", because the to-be-fouled board as a whole is carrying more
 * fouls than the committed board can supply - the per-player ratios are just
 * the one match-level gap repeated twenty times, telling you nothing about any
 * individual. Levelling first strips that shared component out, so what is
 * left is genuinely about the player.
 *
 * `weight` is how far to trust the identity: 0 leaves both boards untouched, 1
 * forces them to meet exactly in the middle. The default is partial because
 * the priced XIs exclude keepers and substitutes, so part of any real gap is
 * structural rather than a mispricing.
 */
export function applyLevelReconciliation(
  fit: BoardFit,
  home: string,
  away: string,
  attribution: number = ATTRIBUTION_RATE,
  weight = 0.5,
): BoardFit {
  const conservation = teamConservation(fit, home, away, attribution);

  const scaleFor = (team: string, market: FoulsMarket): number => {
    const c =
      market === "committed"
        ? conservation.find((x) => x.team === team)
        : conservation.find((x) => x.opponent === team);
    if (!c || !isFinite(c.ratio) || c.ratio <= 0) return 1;
    // Split the gap: committed rises toward the to-be-fouled board, and the
    // to-be-fouled board falls toward committed, each by half the discrepancy.
    const pull = market === "committed" ? Math.log(c.ratio) : -Math.log(c.ratio);
    return Math.exp(weight * 0.5 * pull);
  };

  const rescale = (fits: LadderFit[], market: FoulsMarket): LadderFit[] =>
    fits.map((f) => ({ ...f, mu: f.mu * scaleFor(f.team, market) }));

  return {
    ...fit,
    committed: rescale(fit.committed, "committed"),
    toBeFouled: rescale(fit.toBeFouled, "toBeFouled"),
  };
}

/* ========================================================================== *
 * Consensus pricing and edges
 * ========================================================================== */

export type Edge = {
  player: string;
  team: string;
  market: FoulsMarket;
  line: number;
  fractional: string | null;
  decimal: number;
  /** Probability implied by the posted price, margin included. */
  postedProb: number;
  /** Our fair probability after reconciliation. */
  fairProb: number;
  fairDecimal: number;
  /** (fairProb * decimal) - 1. Positive is value. */
  edge: number;
  /** Fraction of bankroll under full Kelly. */
  kelly: number;
  /** Expected fouls used to price this rung. */
  consensusMu: number;
  /** Market-only expected fouls, before reconciliation. */
  marketMu: number;
  reasons: string[];
};

export type ReconcileOptions = {
  attribution?: number;
  /**
   * How far to trust the cross-board conservation correction, 0..1. At 0 the
   * tool reports pure ladder-shape edges only; at 1 it fully believes the
   * committed board's view of the to-be-fouled board and vice versa. The
   * default is deliberately partial - the identity is sound, but the priced XI
   * excludes keepers and substitutes, so some of any observed gap is structural
   * rather than mispricing.
   */
  conservationWeight?: number;
  /**
   * How far to trust the duel-level structural allocation, 0..1. Lower than
   * conservationWeight by default because it carries a formation prior on top.
   */
  duelWeight?: number;
  /** Ignore edges on rungs priced longer than this (deep tail, thin liquidity). */
  maxDecimal?: number;
  /**
   * Our own expectation per `market|player`, from the historical foul model
   * (foulModel.ts), with the confidence its sample supports.
   *
   * This is the only input here that is not derived from the board itself.
   * Everything else finds the bookmaker disagreeing with the bookmaker; this
   * lets the tool disagree with the bookmaker.
   */
  modelMu?: Map<string, { mu: number; confidence: number }>;
  /**
   * Ceiling on how far the model can pull a price, before per-player
   * confidence scales it down.
   *
   * Kept well below 1 on purpose. The model predicts a player's foul rate
   * genuinely well (0.789 year over year), but the market sees things it
   * cannot: the referee, team news, whether a booked player is being managed,
   * what the game state is likely to be. Treating our number as equal to the
   * price would be overconfident; treating it as worthless wastes the only
   * independent signal available.
   */
  modelWeight?: number;
};

/**
 * Blend each player's market-implied expected fouls with what the opposing
 * board and the duel map say it should be, then re-price every rung off the
 * blended value. An edge is a rung whose posted price is longer than the
 * blended distribution says it deserves.
 *
 * The blend is geometric, in log space, because expected counts are a scale
 * quantity - halving and doubling should be symmetric corrections.
 */
export type BoardAnalysis = {
  /** Raw market fit, before any reconciliation. */
  fit: BoardFit;
  /** Same board after the cross-board level correction. */
  levelFit: BoardFit;
  conservation: TeamConservation[];
  duels: DuelReconciliation[];
  /** Final expected fouls per `market|player`, after level and duel corrections. */
  consensusMu: Map<string, number>;
  edges: Edge[];
};

/**
 * Full pipeline, in the order the stages have to run:
 *
 *   1. level    - reconcile how many fouls the two boards think the match has
 *   2. shape    - allocate those fouls across the duel map and compare
 *   3. price    - re-price every rung off the reconciled expectation
 *
 * The blend at each stage is geometric, in log space, because expected counts
 * are a scale quantity: halving and doubling should be symmetric corrections.
 */
export function analyseBoard(
  fit: BoardFit,
  homeFormation: Formation,
  awayFormation: Formation,
  opts: ReconcileOptions = {},
): BoardAnalysis {
  const attribution = opts.attribution ?? ATTRIBUTION_RATE;
  const wCons = opts.conservationWeight ?? 0.5;
  const wDuel = opts.duelWeight ?? 0.25;
  const wModel = opts.modelWeight ?? 0.35;
  const maxDecimal = opts.maxDecimal ?? 26;

  const home = homeFormation.team;
  const away = awayFormation.team;

  const conservation = teamConservation(fit, home, away, attribution);
  const levelFit = applyLevelReconciliation(fit, home, away, attribution, wCons);
  // Duels are read off the LEVELLED board, so a ratio here is about this
  // player's share of the fouls rather than the match-wide gap.
  const duels = duelReconciliation(levelFit, homeFormation, awayFormation, attribution);

  const structuralByPlayer = new Map<string, number>();
  for (const d of duels) {
    for (const s of d.sufferDiagnostics) {
      structuralByPlayer.set(`toBeFouled|${s.player}`, s.structuralMu);
    }
  }

  const consensusMu = new Map<string, number>();
  const edges: Edge[] = [];

  const process = (levelled: LadderFit[], market: FoulsMarket) => {
    for (const f of levelled) {
      const reasons: string[] = [];
      let logMu = Math.log(Math.max(1e-6, f.mu));

      const c =
        market === "committed"
          ? conservation.find((x) => x.team === f.team)
          : conservation.find((x) => x.opponent === f.team);
      if (c && isFinite(c.ratio) && Math.abs(Math.log(c.ratio)) > 0.05) {
        const direction = market === "committed" ? "up" : "down";
        reasons.push(
          `cross-board gap ${(c.ratio * 100 - 100).toFixed(0)}% (${c.team} committed vs ${c.opponent} fouled) pulls this ${direction}`,
        );
      }

      const structural = structuralByPlayer.get(`${market}|${f.name}`);
      if (structural != null && structural > 1e-6 && f.mu > 1e-6) {
        const ratio = structural / f.mu;
        logMu += wDuel * Math.log(ratio);
        if (Math.abs(Math.log(ratio)) > 0.12) {
          reasons.push(
            `duel map implies ${structural.toFixed(2)} fouls suffered vs board's ${f.mu.toFixed(2)}`,
          );
        }
      }

      // --- historical model -------------------------------------------
      const model = opts.modelMu?.get(`${market}|${f.name}`);
      if (model && model.mu > 1e-6 && f.mu > 1e-6) {
        // Scale by confidence so a player with three seasons behind them moves
        // the number and a new signing with 200 minutes barely does.
        const effective = wModel * Math.max(0, Math.min(1, model.confidence));
        const ratio = model.mu / f.mu;
        logMu += effective * Math.log(ratio);
        if (Math.abs(Math.log(ratio)) > 0.15 && effective > 0.05) {
          reasons.push(
            `record says ${model.mu.toFixed(2)} vs market ${f.mu.toFixed(2)} (${Math.round(model.confidence * 100)}% sample)`,
          );
        }
      }

      const mu = Math.exp(logMu);
      consensusMu.set(`${market}|${f.name}`, mu);

      for (const r of f.rungs) {
        if (r.decimal > maxDecimal) continue;
        const fair = nbSurvival(r.line, mu, fit.size);
        const edge = fair * r.decimal - 1;
        // Full Kelly for a binary bet at decimal odds d with win prob p:
        //   f* = (p*(d-1) - (1-p)) / (d-1)
        const b = r.decimal - 1;
        const kelly = b > 0 ? (fair * b - (1 - fair)) / b : 0;

        const rungReasons = [...reasons];
        if (r.residual < -0.12) {
          rungReasons.push(
            `${r.line}+ sits long of this player's own ladder by ${Math.abs(r.residual).toFixed(2)} logits`,
          );
        }

        edges.push({
          player: f.name,
          team: f.team,
          market,
          line: r.line,
          fractional: r.fractional,
          decimal: r.decimal,
          postedProb: r.postedProb,
          fairProb: fair,
          fairDecimal: fairPrice(fair),
          edge,
          kelly: Math.max(0, kelly),
          consensusMu: mu,
          marketMu: r.line === 1 ? f.mu : f.mu,
          reasons: rungReasons,
        });
      }
    }
  };

  process(levelFit.committed, "committed");
  process(levelFit.toBeFouled, "toBeFouled");

  edges.sort((a, b) => b.edge - a.edge);
  return { fit, levelFit, conservation, duels, consensusMu, edges };
}

/** Convenience wrapper when only the ranked edges are wanted. */
export function findEdges(
  fit: BoardFit,
  homeFormation: Formation,
  awayFormation: Formation,
  opts: ReconcileOptions = {},
): Edge[] {
  return analyseBoard(fit, homeFormation, awayFormation, opts).edges;
}

export { applyMargin };
