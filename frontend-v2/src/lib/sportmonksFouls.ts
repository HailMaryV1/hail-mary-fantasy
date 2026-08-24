/**
 * sportmonksFouls.ts
 * ---------------------------------------------------------------------------
 * Server-side pull of everything the fouls tool needs for a fixture: both
 * bookmaker fouls ladders and, once they exist, the confirmed lineups and
 * formations.
 *
 * A correction worth recording, because it changed this whole feature. The
 * first pass concluded no odds API carries fouls markets, based on
 * /v3/odds/markets returning a 125-entry catalogue with nothing foul-related
 * in it. That catalogue is incomplete. A live fixture (Fulham v Chelsea,
 * 19722194) returns 178 distinct markets, among them "Player Fouls Committed"
 * (market 338) and "Player To Be Fouled", both from bet365, both matching the
 * posted board rung for rung. Never conclude a market is unavailable from the
 * catalogue endpoint alone - check a real fixture close to kickoff.
 *
 * TIMING, measured rather than assumed (2026-08-24):
 *
 *   fouls ladders  - present on matchday for Fulham v Chelsea (rows created six
 *                    days out), but absent four days out for Crystal Palace v
 *                    Man City and absent the day before for several Carabao Cup
 *                    ties, each of which already had 1,000+ other bet365 rows.
 *                    So they open late and unevenly. Poll; do not assume.
 *   lineups        - absent the day before, arriving about an hour before
 *                    kickoff, which is when formations appear too.
 *
 * The tool therefore has to work in two states, and says which one it is in:
 * ODDS ONLY (ladder-shape and cross-board conservation still work) and
 * CONFIRMED XI (adds the duel map). Nothing here fabricates a lineup to fill
 * the gap.
 */

import type { Board, PlayerLadder, OddsQuote } from "./foulsEdge";
import { toDecimal, decimalToFractional } from "./foulsEdge";
import type { Formation, FormationSlot, Role, Flank } from "./foulsMatchup";

const BASE = "https://api.sportmonks.com/v3/football";

/** bet365. Their board is the one the ladders in this tool were built against. */
export const DEFAULT_BOOKMAKER_ID = 2;

/**
 * Leagues this subscription is entitled to that are worth polling. Mirrors
 * ENTITLED_LEAGUE_IDS in scripts/import_sportmonks_player_props.py; kept as a
 * copy rather than shared because that is a Python pipeline script and this is
 * request-time frontend code.
 */
export const ENTITLED_LEAGUES: Record<number, string> = {
  8: "Premier League",
  9: "Championship",
  12: "League One",
  14: "League Two",
  24: "FA Cup",
  27: "Carabao Cup",
};

const COMMITTED_MARKETS = new Set(["Player Fouls Committed", "Alternative Player Fouls Committed"]);
const FOULED_MARKETS = new Set(["Player To Be Fouled", "Alternative Player To Be Fouled"]);

/** SportMonks position type ids seen on lineup rows. */
const POSITION_ROLE: Record<number, Role> = { 24: "GK", 25: "DEF", 26: "MID", 27: "FWD" };
/** type_id 11 = in the starting eleven, 12 = bench. */
const STARTER_TYPE_ID = 11;

function apiKey(): string {
  const k = process.env.SPORTMONKS_API_KEY;
  if (!k) throw new Error("SPORTMONKS_API_KEY is not set for this deployment");
  return k;
}

async function get<T>(path: string, params: Record<string, string> = {}): Promise<T> {
  const qs = new URLSearchParams({ api_token: apiKey(), ...params });
  const res = await fetch(`${BASE}${path}?${qs}`, { cache: "no-store" });
  if (!res.ok) throw new Error(`SportMonks ${path} returned ${res.status}`);
  return (await res.json()) as T;
}

/* ========================================================================== *
 * Fixtures
 * ========================================================================== */

export type FixtureSummary = {
  id: number;
  name: string;
  league: string;
  kickoff: string;
};

export async function listFixtures(fromISO: string, toISO: string): Promise<FixtureSummary[]> {
  type Row = { id: number; name: string; league_id: number; starting_at: string };
  const d = await get<{ data: Row[] }>(`/fixtures/between/${fromISO}/${toISO}`, {
    per_page: "200",
  });
  return (d.data ?? [])
    .filter((f) => ENTITLED_LEAGUES[f.league_id])
    .map((f) => ({
      id: f.id,
      name: f.name,
      league: ENTITLED_LEAGUES[f.league_id],
      kickoff: f.starting_at,
    }))
    .sort((a, b) => a.kickoff.localeCompare(b.kickoff));
}

/* ========================================================================== *
 * Lineups -> formations
 * ========================================================================== */

type LineupRow = {
  player_name: string;
  jersey_number: number | null;
  formation_field: string | null;
  position_id: number;
  type_id: number;
  team_id: number;
};

/**
 * Convert a lineup row's grid slot into a lateral position across the pitch,
 * 0 to 1.
 *
 * `formation_field` is "row:column" - Fulham's back four came back as 2:1
 * Castagne, 2:2 Bassey, 2:3 Cuenca, 2:4 Robinson. The useful property, checked
 * against both teams on a real fixture, is that the column index refers to an
 * ABSOLUTE touchline rather than to the team's own left and right. Fulham's
 * column 1 is Castagne, a right-back; Chelsea's column 1 is Colwill, a
 * left-sided centre-back. Those two are on the same side of the pitch, facing
 * each other - which is exactly the pairing the duel map needs.
 *
 * So no home/away flipping is applied here, and none should be: doing the
 * flip would put both full-backs on the wrong flank and invert every duel.
 */
function lateralOf(field: string | null, rowWidth: number): number | undefined {
  if (!field) return undefined;
  const [, colRaw] = field.split(":");
  const col = parseInt(colRaw, 10);
  if (!isFinite(col)) return undefined;
  if (rowWidth <= 1) return 0.5;
  return (col - 1) / (rowWidth - 1);
}

/** Coarse L/C/R, kept so a lineup still works with the bucketed fallback path. */
function flankOf(lateral: number | undefined): Flank {
  if (lateral === undefined) return "C";
  if (lateral < 0.28) return "L";
  if (lateral > 0.72) return "R";
  return "C";
}

export type LineupResult = {
  formations: Formation[];
  /** True when both sides have a confirmed eleven, which is what the duel map needs. */
  confirmed: boolean;
};

export async function fetchLineups(fixtureId: number): Promise<LineupResult & { teams: Record<number, string> }> {
  type Participant = { id: number; name: string; meta: { location: string } };
  type FormationRow = { participant_id: number; formation: string };
  type Data = {
    data: { lineups?: LineupRow[]; formations?: FormationRow[]; participants?: Participant[] };
  };
  const d = await get<Data>(`/fixtures/${fixtureId}`, {
    include: "lineups;formations;participants",
  });
  const data = d.data ?? {};
  const participants = data.participants ?? [];
  const teams: Record<number, string> = {};
  for (const p of participants) teams[p.id] = p.name;

  const shapes: Record<number, string> = {};
  for (const f of data.formations ?? []) shapes[f.participant_id] = f.formation;

  const starters = (data.lineups ?? []).filter((l) => l.type_id === STARTER_TYPE_ID);

  // Home first, so the caller's home/away labelling matches SportMonks'.
  const ordered = [...participants].sort((a, b) =>
    a.meta.location === "home" ? -1 : b.meta.location === "home" ? 1 : 0,
  );

  const formations: Formation[] = [];
  for (const p of ordered) {
    const rows = starters.filter((l) => l.team_id === p.id);
    if (!rows.length) continue;

    // Width of each pitch row, needed to normalise the column index.
    const widths = new Map<string, number>();
    for (const r of rows) {
      const row = (r.formation_field ?? "").split(":")[0];
      widths.set(row, (widths.get(row) ?? 0) + 1);
    }

    const slots: FormationSlot[] = rows.map((r) => {
      const row = (r.formation_field ?? "").split(":")[0];
      const lateral = lateralOf(r.formation_field, widths.get(row) ?? 1);
      return {
        name: r.player_name,
        shirt: r.jersey_number,
        team: p.name,
        role: POSITION_ROLE[r.position_id] ?? "MID",
        flank: flankOf(lateral),
        lateral,
      };
    });

    formations.push({ team: p.name, shape: shapes[p.id] ?? "", slots });
  }

  return { formations, confirmed: formations.length === 2, teams };
}

/* ========================================================================== *
 * Odds -> ladders
 * ========================================================================== */

type OddRow = {
  label: string | null;
  value: string | null;
  name: string | null;
  fractional: string | null;
  market_description: string | null;
  bookmaker_id: number;
  stopped?: boolean;
  latest_bookmaker_update?: string;
};

async function fetchAllOdds(fixtureId: number): Promise<OddRow[]> {
  const rows: OddRow[] = [];
  for (let page = 1; page <= 25; page++) {
    const d = await get<{ data: OddRow[]; pagination?: { has_more?: boolean } }>(
      `/odds/pre-match/fixtures/${fixtureId}`,
      { per_page: "1000", page: String(page) },
    );
    rows.push(...(d.data ?? []));
    if (!d.pagination?.has_more) break;
  }
  return rows;
}

/** "3+" -> 3. Anything that is not an N+ rung is ignored. */
function lineOf(label: string | null): number | null {
  const m = (label ?? "").match(/^(\d+)\+$/);
  return m ? parseInt(m[1], 10) : null;
}

function laddersFrom(
  rows: OddRow[],
  markets: Set<string>,
  teamOf: (playerName: string) => string | null,
  maxLine: number,
): PlayerLadder[] {
  const byPlayer = new Map<string, Map<number, OddRow>>();
  for (const r of rows) {
    if (!r.market_description || !markets.has(r.market_description)) continue;
    if (!r.name) continue;
    const line = lineOf(r.label);
    if (line == null || line > maxLine) continue;
    if (!byPlayer.has(r.name)) byPlayer.set(r.name, new Map());
    // Keep the shortest price if a rung somehow appears twice; a duplicate is
    // an alternative-market overlap, not two independent opinions.
    const slot = byPlayer.get(r.name)!;
    const existing = slot.get(line);
    if (!existing || parseFloat(r.value ?? "999") < parseFloat(existing.value ?? "999")) {
      slot.set(line, r);
    }
  }

  const out: PlayerLadder[] = [];
  for (const [name, lines] of byPlayer) {
    const team = teamOf(name);
    if (!team) continue; // not in a confirmed XI - skipped, never guessed at
    const quotes: OddsQuote[] = [];
    for (let line = 1; line <= maxLine; line++) {
      const row = lines.get(line);
      const dec = row?.value ? parseFloat(row.value) : row?.fractional ? toDecimal(row.fractional) : null;
      const usable = dec != null && isFinite(dec) && dec > 1 && !row?.stopped;
      quotes.push({
        line,
        // Derived from the decimal, never taken from SportMonks' own
        // `fractional` field - see decimalToFractional for why.
        fractional: usable ? decimalToFractional(dec!) : null,
        decimal: usable ? dec : null,
        suspended: !usable,
      });
    }
    out.push({ name, team, quotes });
  }
  return out;
}

/* ========================================================================== *
 * Combined
 * ========================================================================== */

export type LiveBoardResult = {
  fixtureId: number;
  fixtureName: string;
  kickoff: string | null;
  board: Board;
  formations: Formation[];
  /** Lineups confirmed, so the duel map is available. */
  lineupsConfirmed: boolean;
  /** Fouls markets present at all. */
  hasFoulsMarkets: boolean;
  bookmakerUpdatedAt: string | null;
  notes: string[];
};

/**
 * Everything for one fixture in a single call.
 *
 * Ladders are restricted to players in a confirmed starting eleven. That is not
 * a limitation to work around: the conservation identity this tool depends on
 * compares one team's committed total against the other's fouled total, and
 * mixing a starter's ninety minutes with a substitute's twenty would break the
 * comparison in a way no later correction recovers. Substitutes are priced by
 * the bookmaker and deliberately dropped here.
 */
export async function fetchLiveBoard(
  fixtureId: number,
  opts: { bookmakerId?: number; maxLine?: number } = {},
): Promise<LiveBoardResult> {
  const bookmakerId = opts.bookmakerId ?? DEFAULT_BOOKMAKER_ID;
  const maxLine = opts.maxLine ?? 5;
  const notes: string[] = [];

  const [lineups, allOdds] = await Promise.all([fetchLineups(fixtureId), fetchAllOdds(fixtureId)]);
  const odds = allOdds.filter((r) => r.bookmaker_id === bookmakerId);

  const hasFoulsMarkets = odds.some(
    (r) =>
      r.market_description &&
      (COMMITTED_MARKETS.has(r.market_description) || FOULED_MARKETS.has(r.market_description)),
  );

  const nameIndex = new Map<string, string>();
  for (const f of lineups.formations) {
    for (const s of f.slots) nameIndex.set(normalise(s.name), f.team);
  }
  const teamOf = (playerName: string): string | null => {
    const n = normalise(playerName);
    if (nameIndex.has(n)) return nameIndex.get(n)!;
    // Surname fallback, safe because the index holds only these 22 players.
    const surname = n.split(" ").slice(-1)[0];
    const hits = [...nameIndex.entries()].filter(([k]) => k.split(" ").slice(-1)[0] === surname);
    return hits.length === 1 ? hits[0][1] : null;
  };

  const committed = laddersFrom(odds, COMMITTED_MARKETS, teamOf, maxLine);
  const toBeFouled = laddersFrom(odds, FOULED_MARKETS, teamOf, maxLine);

  if (!hasFoulsMarkets) {
    notes.push(
      "No fouls markets posted for this fixture yet. They open late and unevenly - often not until matchday.",
    );
  }
  if (!lineups.confirmed) {
    notes.push(
      "Lineups not confirmed yet (they land about an hour before kickoff). Ladder-shape and cross-board checks still work; the duel map does not.",
    );
  }
  if (hasFoulsMarkets && lineups.confirmed && committed.length < 8) {
    notes.push(
      `Only ${committed.length} starters have a fouls-committed ladder - the board may still be filling out.`,
    );
  }

  const updates = odds
    .map((r) => r.latest_bookmaker_update)
    .filter((v): v is string => Boolean(v))
    .sort();

  const [home, away] = lineups.formations;
  return {
    fixtureId,
    fixtureName: Object.values(lineups.teams).join(" vs "),
    kickoff: null,
    board: {
      home: home?.team ?? "Home",
      away: away?.team ?? "Away",
      committed,
      toBeFouled,
    },
    formations: lineups.formations,
    lineupsConfirmed: lineups.confirmed,
    hasFoulsMarkets,
    bookmakerUpdatedAt: updates.length ? updates[updates.length - 1] : null,
    notes,
  };
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
