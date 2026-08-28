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
import { loadFoulModel } from "./foulModelStore";
import { projectFixture, type ModelledPlayer } from "./foulModel";

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

/**
 * Fouls markets are matched by NUMERIC MARKET ID, not by description.
 *
 * This is not a stylistic preference - matching on the description string was a
 * real bug that silently returned an empty board. The same market comes back
 * under different names on different fixtures: Fulham v Chelsea served it as
 * "Player Fouls Committed", Crystal Palace v Man City as plain "Fouls
 * Committed", both with market_id 338 and both the identical 1+/2+/3+/4+/5+
 * player ladder. The "Player " prefix drops off other markets too - Shots,
 * Tackles, Shots On Target - so this is a general inconsistency in the feed,
 * not a one-off.
 *
 * The failure mode was quiet, which is the worst part: the page correctly
 * reported "no fouls markets posted yet" for a fixture where bet365 had 176
 * rows of them, because that is genuinely indistinguishable from a market that
 * has not opened. Ids do not drift.
 */
const COMMITTED_MARKET_ID = 338;
const FOULED_MARKET_ID = 339;

/**
 * Description fallback, used only when a row somehow carries no market_id.
 * Compared after normalising away the "Player " and "Alternative " prefixes
 * that come and go between fixtures.
 */
const COMMITTED_MARKET_NAMES = new Set(["fouls committed"]);
const FOULED_MARKET_NAMES = new Set(["to be fouled"]);

/** Strip the prefixes the feed applies inconsistently. */
function normaliseMarket(description: string | null): string {
  return (description ?? "")
    .toLowerCase()
    .replace(/^alternative\s+/, "")
    .replace(/^player\s+/, "")
    .replace(/\s+/g, " ")
    .trim();
}

function isMarket(row: { market_id?: number | null; market_description: string | null }, id: number, names: Set<string>) {
  if (row.market_id === id) return true;
  if (row.market_id != null) return false;
  return names.has(normaliseMarket(row.market_description));
}

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
  player_id: number;
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

export async function fetchLineups(
  fixtureId: number,
): Promise<LineupResult & { teams: Record<number, string>; teamIds: number[] }> {
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
        playerId: r.player_id,
        team: p.name,
        role: POSITION_ROLE[r.position_id] ?? "MID",
        flank: flankOf(lateral),
        lateral,
      };
    });

    formations.push({ team: p.name, shape: shapes[p.id] ?? "", slots });
  }

  return { formations, confirmed: formations.length === 2, teams, teamIds: ordered.map((p) => p.id) };
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
  /** Stable across fixtures, unlike market_description - see COMMITTED_MARKET_ID. */
  market_id?: number | null;
  bookmaker_id: number;
  stopped?: boolean;
  latest_bookmaker_update?: string;
  /** The line an over/under market is set at; null on N+ ladder rungs. */
  total?: string | null;
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
  matches: (row: OddRow) => boolean,
  teamOf: (playerName: string) => string | null,
  maxLine: number,
): PlayerLadder[] {
  const byPlayer = new Map<string, Map<number, OddRow>>();
  for (const r of rows) {
    if (!matches(r)) continue;
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
 * Deriving the two settings that were previously typed in by hand
 * ========================================================================== */

/**
 * Fallback average total fouls in a match, both teams. Measured from 40
 * completed fixtures across the entitled leagues on 2026-08-24: mean 23.4,
 * standard deviation 4.9. Used only when a fixture's own two teams have too
 * little history to derive from.
 *
 * Worth stating because an earlier version of this tool assumed 21 from
 * general knowledge and concluded on that basis that the board was running
 * badly hot. Measuring moved the baseline by more than two fouls and softened
 * that verdict considerably - which is exactly why this is now derived per
 * fixture rather than typed in.
 */
export const LEAGUE_BASELINE_MATCH_FOULS = 23.4;

const FOULS_STAT_TYPE_ID = 56;

/**
 * Bookmaker margin, measured rather than assumed.
 *
 * The fouls ladders are one-sided - only the "yes" price for each rung is
 * published - so their margin cannot be read off directly. But bet365 posts
 * plenty of TWO-way markets on the same fixture, and a two-way market's
 * overround is simply 1/over + 1/under - 1.
 *
 * Only the player-prop over/under markets are used as the reference. They are
 * the same product family, priced by the same model, and on a real fixture
 * they came out at 8.1% (Player Shots) and 7.6% (Player Shots On Target) -
 * tight agreement. Match-level goal and corner lines run noticeably thinner
 * (4-6%) and would understate what a player ladder is taxed, while a few
 * Asian-style markets return negative overrounds because their two rows are
 * not a genuine complementary pair.
 *
 * A caveat that should not be lost: a two-way line is still not the same thing
 * as a five-rung ladder, and books usually tax longshot rungs harder than a
 * near-even over/under. Treat this as a well-founded floor rather than proof.
 */
const OVERROUND_REFERENCE_MARKETS = new Set([
  "shots over/under",
  "shots on target over/under",
  "match shots",
  "match shots on target",
  "match tackles",
]);

function median(values: number[]): number | null {
  if (!values.length) return null;
  const s = [...values].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

export function deriveOverround(rows: OddRow[]): { value: number | null; sampleSize: number } {
  const pairs = new Map<string, { over?: number; under?: number }>();
  for (const r of rows) {
    if (!OVERROUND_REFERENCE_MARKETS.has(normaliseMarket(r.market_description))) continue;
    const label = r.label ?? "";
    if (label !== "Over" && label !== "Under") continue;
    const key = `${r.market_description}|${r.name}|${r.total}`;
    const entry = pairs.get(key) ?? {};
    const price = parseFloat(r.value ?? "");
    if (!isFinite(price) || price <= 1) continue;
    if (label === "Over") entry.over = price;
    else entry.under = price;
    pairs.set(key, entry);
  }

  const overrounds: number[] = [];
  for (const { over, under } of pairs.values()) {
    if (over && under) overrounds.push((1 / over + 1 / under - 1) * 100);
  }
  // Median, not mean: one mispaired row can otherwise drag the estimate far off.
  const value = median(overrounds.filter((v) => v > 0 && v < 40));
  return { value, sampleSize: overrounds.length };
}

/**
 * Expected total fouls in this match, from how many fouls these two sides
 * actually commit, rather than a league constant.
 *
 * Each team's recent completed fixtures carry a Fouls statistic, so the match
 * expectation is simply the two teams' own averages added together. Shrunk
 * toward the league baseline when a team has little history, so a side with two
 * matches played does not swing the estimate on noise.
 */
export async function deriveExpectedFouls(
  teamIds: number[],
  sampleSize = 8,
): Promise<{ value: number; perTeam: { teamId: number; mean: number; matches: number }[] }> {
  const to = new Date();
  const from = new Date(to.getTime() - 200 * 24 * 60 * 60 * 1000);
  const iso = (d: Date) => d.toISOString().slice(0, 10);

  type StatRow = { participant_id: number; type?: { id: number }; data?: { value?: number } };
  type FixtureRow = { state_id: number; statistics?: StatRow[] };

  const perTeam: { teamId: number; mean: number; matches: number }[] = [];

  for (const teamId of teamIds) {
    let mean = LEAGUE_BASELINE_MATCH_FOULS / 2;
    let matches = 0;
    try {
      const d = await get<{ data: FixtureRow[] }>(
        `/fixtures/between/${iso(from)}/${iso(to)}/${teamId}`,
        { include: "statistics.type", per_page: "50" },
      );
      const values: number[] = [];
      for (const f of (d.data ?? []).filter((x) => x.state_id === 5)) {
        for (const st of f.statistics ?? []) {
          if (st.type?.id === FOULS_STAT_TYPE_ID && st.participant_id === teamId) {
            const v = st.data?.value;
            if (typeof v === "number") values.push(v);
          }
        }
      }
      const recent = values.slice(-sampleSize);
      matches = recent.length;
      if (matches > 0) {
        const raw = recent.reduce((a, b) => a + b, 0) / matches;
        // Shrink toward the league half-match baseline; full weight by ~6 games.
        const w = matches / (matches + 3);
        mean = w * raw + (1 - w) * (LEAGUE_BASELINE_MATCH_FOULS / 2);
      }
    } catch {
      // Leave the baseline in place - a failed history lookup must not stop the
      // board from being analysed at all.
    }
    perTeam.push({ teamId, mean, matches });
  }

  return { value: perTeam.reduce((a, t) => a + t.mean, 0), perTeam };
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
  /** Margin measured from bet365's own two-way player props on this fixture. */
  derivedOverround: number | null;
  overroundSample: number;
  /** Expected total match fouls from these two teams' own recent records. */
  derivedExpectedFouls: number;
  expectedFoulsBasis: { team: string; mean: number; matches: number }[];
  /**
   * Our own expectation per player, keyed "committed|Name" / "toBeFouled|Name"
   * so the engine can look it up directly against a ladder.
   */
  model: Record<string, { mu: number; confidence: number }>;
  /** Per-player model detail, for display. */
  modelPlayers: ModelledPlayer[];
  /** How many of the 22 starters had any foul history at all. */
  modelCoverage: { covered: number; requested: number };
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

  const isCommitted = (r: OddRow) => isMarket(r, COMMITTED_MARKET_ID, COMMITTED_MARKET_NAMES);
  const isFouled = (r: OddRow) => isMarket(r, FOULED_MARKET_ID, FOULED_MARKET_NAMES);
  const hasFoulsMarkets = odds.some((r) => isCommitted(r) || isFouled(r));

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

  const committed = laddersFrom(odds, isCommitted, teamOf, maxLine);
  const toBeFouled = laddersFrom(odds, isFouled, teamOf, maxLine);

  // Never fail silently on a naming change again.
  //
  // The description string moves between fixtures ("Player Fouls Committed" on
  // one, "Fouls Committed" on another), and when it did, this returned an empty
  // board and reported "not posted yet" - indistinguishable from a market that
  // genuinely had not opened, for a fixture where bet365 had 176 rows of fouls
  // prices sitting there. Matching by id fixed that instance; this makes the
  // NEXT instance loud instead of invisible. Anything that looks like a fouls
  // market but did not match is surfaced with its id, so a new variant is a
  // visible message rather than a quiet blank.
  const unmatchedFoulMarkets = new Map<string, number | null | undefined>();
  for (const r of odds) {
    if (isCommitted(r) || isFouled(r)) continue;
    const name = normaliseMarket(r.market_description);
    if (name.includes("foul")) unmatchedFoulMarkets.set(r.market_description ?? name, r.market_id);
  }
  if (unmatchedFoulMarkets.size > 0) {
    const described = [...unmatchedFoulMarkets.entries()]
      .map(([name, id]) => `"${name}" (market_id ${id ?? "none"})`)
      .join(", ");
    notes.push(
      `Unrecognised fouls market on this fixture: ${described}. It is being ignored - the market ids in sportmonksFouls.ts need extending.`,
    );
  }

  if (!hasFoulsMarkets) {
    notes.push(
      unmatchedFoulMarkets.size > 0
        ? "No fouls ladders matched, but the fixture does carry fouls-like markets - see the note above; this is a feed change, not an unopened market."
        : "No fouls markets posted for this fixture yet. They open late and unevenly - often not until matchday.",
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

  const overround = deriveOverround(odds);
  const expected = await deriveExpectedFouls(lineups.teamIds);
  const expectedBasis = expected.perTeam.map((t) => ({
    team: lineups.teams[t.teamId] ?? String(t.teamId),
    mean: t.mean,
    matches: t.matches,
  }));
  if (overround.value == null) {
    notes.push(
      "No two-way player props on this fixture to measure the margin from - falling back to the typed value.",
    );
  }
  for (const t of expectedBasis) {
    if (t.matches < 3) {
      notes.push(
        `${t.team} has only ${t.matches} completed matches with foul data, so the expected-fouls estimate leans on the league baseline.`,
      );
    }
  }

  // --- our own model ----------------------------------------------------
  const model: Record<string, { mu: number; confidence: number }> = {};
  const modelPlayers: ModelledPlayer[] = [];
  let modelCoverage = { covered: 0, requested: 0 };
  try {
    const slotIds: number[] = [];
    for (const f of lineups.formations) {
      for (const s of f.slots) if (s.playerId) slotIds.push(s.playerId);
    }
    const loaded = await loadFoulModel(slotIds, lineups.teamIds);
    modelCoverage = { covered: loaded.covered, requested: slotIds.length };

    // Opponent profile is the OTHER team's squad, which is what the crosswise
    // adjustment in projectFixture needs.
    const teamIdByName = new Map<string, number>();
    for (const [id, name] of Object.entries(lineups.teams)) teamIdByName.set(name, Number(id));

    for (const f of lineups.formations) {
      const ownId = teamIdByName.get(f.team);
      const opponentId = lineups.teamIds.find((id) => id !== ownId) ?? null;
      const opponent = opponentId != null ? (loaded.teamProfiles.get(opponentId) ?? null) : null;
      for (const slot of f.slots) {
        if (!slot.playerId) continue;
        const rate = loaded.rates.get(slot.playerId);
        if (!rate) continue;
        const projected = projectFixture(rate, f.team, opponent);
        // Key on the BOARD's spelling of the name, not the lineup's - the two
        // feeds disagree about diacritics and the engine looks these up by the
        // board's name.
        const boardName =
          committed.find((l) => normalise(l.name) === normalise(slot.name))?.name ?? slot.name;
        modelPlayers.push({ ...projected, playerName: boardName });
        model[`committed|${boardName}`] = { mu: projected.committed, confidence: projected.confidence };
        model[`toBeFouled|${boardName}`] = { mu: projected.suffered, confidence: projected.confidence };
      }
    }
    if (modelCoverage.requested > 0 && modelCoverage.covered < modelCoverage.requested * 0.6) {
      notes.push(
        `Foul history covers only ${modelCoverage.covered} of ${modelCoverage.requested} starters - the model correction will be weak. Run scripts/import_foul_stats.py if this looks wrong.`,
      );
    }
  } catch (err) {
    // A missing or unreachable history table must never stop the board being
    // analysed; the market-consistency checks stand on their own.
    notes.push(`Historical foul model unavailable: ${(err as Error).message}`);
  }

  const updates = odds
    .map((r) => r.latest_bookmaker_update)
    .filter((v): v is string => Boolean(v))
    .sort();

  const [home, away] = lineups.formations;
  return {
    fixtureId,
    // Home first. Object.values() follows key insertion order, which is
    // SportMonks' participant order, not home/away - it rendered a real
    // fixture as "Manchester City vs Crystal Palace" when Palace were at home.
    fixtureName:
      lineups.formations.length === 2
        ? `${lineups.formations[0].team} vs ${lineups.formations[1].team}`
        : Object.values(lineups.teams).join(" vs "),
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
    derivedOverround: overround.value,
    overroundSample: overround.sampleSize,
    derivedExpectedFouls: expected.value,
    expectedFoulsBasis: expectedBasis,
    model,
    modelPlayers,
    modelCoverage,
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
