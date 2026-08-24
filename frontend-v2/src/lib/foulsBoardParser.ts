/**
 * foulsBoardParser.ts
 * ---------------------------------------------------------------------------
 * Turns a fouls board copied off a bookmaker page into structured ladders, and
 * a typed team sheet into a Formation.
 *
 * Pasting is the fallback route, not the only one - SportMonks' bet365 feed
 * does carry both markets (see sportmonksFouls.ts). It stays because those
 * markets open late and unevenly, so there will be mornings when the feed has
 * nothing for a fixture whose board is already on screen. The parser therefore
 * has to be forgiving about what a copied table actually looks like.
 *
 * What it copes with:
 *   - shirt numbers glued to names, or absent
 *   - names split across several tokens
 *   - prices as fractions ("11/10"), "evens", or decimals
 *   - suspended rungs written as "-", "x", or a padlock that copied as nothing
 *
 * The one thing it cannot recover is WHICH rung a suspended price belonged to
 * when the padlock left no character behind. Prices are assigned to lines 1, 2,
 * 3... in the order they appear, which is right whenever the suspensions are
 * trailing (nearly always - books suspend the deep end first). An interior gap,
 * like Palacios' suspended 2+ with a priced 3+ in the reference board, has to
 * be typed as an explicit "-" or it will silently shift the ladder up a rung.
 */

import type { PlayerLadder, OddsQuote, Board } from "./foulsEdge";
import { toDecimal } from "./foulsEdge";
import type { Formation, FormationSlot, Role, Flank } from "./foulsMatchup";

const PRICE = /^(?:\d+(?:\.\d+)?\s*\/\s*\d+(?:\.\d+)?|evens|evs|even|\d+\.\d+)$/i;
const SUSPENDED = /^(?:-|x|\u{1F512}|\u{1F510})$/u;

function isPrice(tok: string): boolean {
  return PRICE.test(tok);
}

export type ParsedLadder = { name: string; shirt: number | null; prices: (string | null)[] };

/**
 * Pull player rows out of pasted text. A row is "some name tokens, then a run
 * of price tokens"; the next non-price token starts the next player.
 */
export function parseLadderText(text: string, lines = 5): ParsedLadder[] {
  const tokens = text
    .replace(/ /g, " ")
    .split(/[\s\r\n]+/)
    .map((t) => t.trim())
    .filter(Boolean);

  const out: ParsedLadder[] = [];
  let nameParts: string[] = [];
  let prices: (string | null)[] = [];
  let shirt: number | null = null;

  const flush = () => {
    if (nameParts.length && prices.length) {
      out.push({
        name: nameParts.join(" ").replace(/\s+/g, " ").trim(),
        shirt,
        prices: prices.slice(0, lines),
      });
    }
    nameParts = [];
    prices = [];
    shirt = null;
  };

  for (const tok of tokens) {
    if (isPrice(tok)) {
      prices.push(tok);
      continue;
    }
    if (SUSPENDED.test(tok)) {
      // Only meaningful once we are inside a player's price run; a stray dash
      // in a header line should not open one.
      if (nameParts.length) prices.push(null);
      continue;
    }
    // A non-price token after prices means the previous player is finished.
    if (prices.length) flush();
    // A bare integer immediately before a name is a shirt number.
    if (/^\d{1,2}$/.test(tok) && !nameParts.length) {
      shirt = parseInt(tok, 10);
      continue;
    }
    nameParts.push(tok);
  }
  flush();
  return out;
}

/** Build ladders, resolving each player's team from the two formations. */
export function buildLadders(
  parsed: ParsedLadder[],
  formations: Formation[],
  lines = 5,
): { ladders: PlayerLadder[]; unmatched: string[] } {
  const index = new Map<string, string>();
  for (const f of formations) {
    for (const s of f.slots) index.set(normalise(s.name), f.team);
  }

  const ladders: PlayerLadder[] = [];
  const unmatched: string[] = [];

  for (const p of parsed) {
    const team = index.get(normalise(p.name)) ?? matchLoosely(p.name, index);
    if (!team) {
      unmatched.push(p.name);
      continue;
    }
    const quotes: OddsQuote[] = [];
    for (let i = 0; i < lines; i++) {
      const raw = p.prices[i] ?? null;
      const dec = raw ? toDecimal(raw) : null;
      quotes.push({
        line: i + 1,
        fractional: dec != null ? raw : null,
        decimal: dec,
        suspended: dec == null,
      });
    }
    ladders.push({ name: canonicalName(p.name, formations), shirt: p.shirt, team, quotes });
  }
  return { ladders, unmatched };
}

function normalise(s: string): string {
  return s
    .toLowerCase()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^a-z ]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Boards abbreviate ("J. Acheam...", "Joao Pedro" vs "João Pedro"), so fall
 * back to surname matching. Scoped to the 22 players in the team sheets, which
 * is what makes a match this loose safe - it is not searching a whole league.
 */
function matchLoosely(name: string, index: Map<string, string>): string | null {
  const n = normalise(name);
  const surname = n.split(" ").slice(-1)[0];
  if (!surname || surname.length < 3) return null;
  const hits: string[] = [];
  for (const [key, team] of index) {
    const keySurname = key.split(" ").slice(-1)[0];
    if (keySurname === surname || key.startsWith(n) || n.startsWith(key)) hits.push(team);
  }
  // Ambiguous surname across both squads - refuse rather than guess wrong.
  return hits.length === 1 ? hits[0] : null;
}

function canonicalName(name: string, formations: Formation[]): string {
  const n = normalise(name);
  for (const f of formations) {
    for (const s of f.slots) {
      const k = normalise(s.name);
      if (k === n || k.split(" ").slice(-1)[0] === n.split(" ").slice(-1)[0]) return s.name;
    }
  }
  return name;
}

/* ========================================================================== *
 * Team sheet
 * ========================================================================== */

const ROLES: Role[] = ["GK", "DEF", "MID", "FWD"];
const FLANKS: Flank[] = ["L", "C", "R"];

/**
 * Parse a team sheet written one player per line:
 *
 *   Antonee Robinson, DEF, L
 *   Sander Berge, MID, C
 *
 * Flank is from the player's own point of view - a left-back is L - because
 * that is how a team sheet reads. foulsMatchup.ts maps those onto absolute
 * touchlines so the two teams face each other the right way round.
 */
export function parseTeamSheet(team: string, shape: string, text: string): {
  formation: Formation;
  errors: string[];
} {
  const errors: string[] = [];
  const slots: FormationSlot[] = [];

  for (const raw of text.split(/\r?\n/)) {
    const lineText = raw.trim();
    if (!lineText) continue;
    const parts = lineText.split(",").map((p) => p.trim());
    if (parts.length < 3) {
      errors.push(`"${lineText}" - expected "Name, ROLE, FLANK"`);
      continue;
    }
    const [name, roleRaw, flankRaw] = parts;
    const role = roleRaw.toUpperCase() as Role;
    const flank = flankRaw.toUpperCase() as Flank;
    if (!ROLES.includes(role)) {
      errors.push(`"${name}" - role "${roleRaw}" must be one of ${ROLES.join("/")}`);
      continue;
    }
    if (!FLANKS.includes(flank)) {
      errors.push(`"${name}" - flank "${flankRaw}" must be one of ${FLANKS.join("/")}`);
      continue;
    }
    slots.push({ name, team, role, flank });
  }

  return { formation: { team, shape, slots }, errors };
}

/** Assemble a full board from both pasted markets and both team sheets. */
export function buildBoard(
  committedText: string,
  toBeFouledText: string,
  homeFormation: Formation,
  awayFormation: Formation,
): { board: Board; warnings: string[] } {
  const formations = [homeFormation, awayFormation];
  const warnings: string[] = [];

  const c = buildLadders(parseLadderText(committedText), formations);
  const f = buildLadders(parseLadderText(toBeFouledText), formations);

  for (const n of c.unmatched) warnings.push(`Fouls committed: "${n}" is not in either team sheet`);
  for (const n of f.unmatched) warnings.push(`To be fouled: "${n}" is not in either team sheet`);

  if (c.ladders.length && f.ladders.length) {
    const cNames = new Set(c.ladders.map((l) => l.name));
    for (const l of f.ladders) {
      if (!cNames.has(l.name)) {
        warnings.push(`"${l.name}" is priced to be fouled but has no fouls-committed ladder`);
      }
    }
  }

  return {
    board: {
      home: homeFormation.team,
      away: awayFormation.team,
      committed: c.ladders,
      toBeFouled: f.ladders,
    },
    warnings,
  };
}
