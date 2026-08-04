// FanTeam's real transfer economy (from the user's copy of FanTeam's own
// rules page): 1 free transfer per gameweek, banking up to 37, -4 points
// per transfer beyond that; 2 wildcards (WC1 usable gameweeks 2-19, WC2
// gameweeks 20-38), each resetting banked free transfers to zero on
// activation. Previously duplicated as inline magic numbers inside
// squads/actions.ts's makeTransfer - extracted so the Ask Mary bundle
// search (which needs to know the cost of a hypothetical Nth transfer
// before it happens) and the real enforcement path can't drift apart.

export const TRANSFER_HIT_COST = -4;

// The real banking cap - was only documented in the comment above until
// the Ask Mary gameweek plan needed to actually simulate accrual forward
// across several gameweeks.
export const MAX_BANKED_FREE_TRANSFERS = 37;

export function accrueFreeTransfers(current: number): number {
  return Math.min(current + 1, MAX_BANKED_FREE_TRANSFERS);
}

export function wildcardWindowFor(gameweek: number): "wc1" | "wc2" | null {
  if (gameweek >= 2 && gameweek <= 19) return "wc1";
  if (gameweek >= 20 && gameweek <= 38) return "wc2";
  return null;
}

export function isWildcardActive(
  gameweek: number,
  wildcard1UsedGameweek: number | null,
  wildcard2UsedGameweek: number | null
): boolean {
  return wildcard1UsedGameweek === gameweek || wildcard2UsedGameweek === gameweek;
}

/**
 * Cost (in points, 0 or negative) of the next transfer given how many
 * free transfers are currently banked and whether a wildcard is active.
 * Doesn't mutate anything - a caller simulating a multi-transfer bundle
 * calls this once per hypothetical slot, decrementing their own working
 * copy of freeTransfersRemaining between calls when a slot actually
 * consumes one (see askMaryEngine.ts's bundle search) the same way
 * executeTransfer's real bookkeeping does.
 */
export function transferCost(freeTransfersRemaining: number, wildcardActive: boolean): number {
  if (wildcardActive) return 0;
  return freeTransfersRemaining > 0 ? 0 : TRANSFER_HIT_COST;
}

// Dream Team's real transfer economy (from the user's own copy of Dream
// Team's official rules, section 1.2.5.2): 2 transfers per gameweek,
// rolling over unused ones up to a max of 6 - confirmed hard-capped, no
// point-cost-per-extra-transfer mechanism exists like FanTeam's (the user
// confirmed this directly rather than it being inferred from the rules
// text, which is silent on what happens past the cap). No wildcard
// concept either.
export const DREAMTEAM_STARTING_FREE_TRANSFERS = 2;
export const DREAMTEAM_MAX_BANKED_FREE_TRANSFERS = 6;

export function dreamteamAccrueFreeTransfers(current: number): number {
  return Math.min(current + DREAMTEAM_STARTING_FREE_TRANSFERS, DREAMTEAM_MAX_BANKED_FREE_TRANSFERS);
}

/**
 * A hard cap has no "cost above the cap," so -Infinity is used rather
 * than a real point value - this plugs straight into every existing
 * netGain = expectedGain + cost calculation in askMaryEngine.ts (see
 * e.g. singleNetGain) so an over-the-cap transfer is never chosen,
 * without that search logic needing a separate "is this even legal"
 * branch of its own.
 */
export function dreamteamTransferCost(freeTransfersRemaining: number): number {
  return freeTransfersRemaining > 0 ? 0 : -Infinity;
}
