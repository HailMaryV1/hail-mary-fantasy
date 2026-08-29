/**
 * spreadexFouls.ts
 * ---------------------------------------------------------------------------
 * Replaces sportmonksFouls.ts as the data source for /fouls (2026-08-29 user
 * request - "switch the pipeline for the fouls board to bring from spreadex").
 *
 * Spreadex has no "To Be Fouled" market, so this is not a drop-in swap of the
 * old two-sided (Fouls Committed vs To Be Fouled) board. The old duel-map and
 * cross-board conservation check (foulsMatchup.ts) were built specifically
 * around comparing one team's committed ladder against the opponent's fouled
 * ladder - that comparison has no real market on either side any more.
 *
 * The replacement, per the user's own framing (2026-08-29): a player heavily
 * involved in tackling is more likely to be in the "battle" and so more
 * likely to commit a foul one way or another. So this reads THREE real
 * Spreadex markets - Fouls Committed, Tackles, and Total Cards O/U - plus
 * real confirmed lineups, and finds edge by comparing the Fouls Committed
 * market's own fitted rate against our historical per-player model
 * (foulModel.ts, unchanged). Tackles is shown as context - who is most "in
 * the battle" - not run through an independent model comparison, since there
 * is no historical tackle-rate table to check it against.
 *
 * player_foul_stats (migration 0142, still SportMonks-sourced season
 * aggregates - a separate, historical concern from live odds) is keyed by
 * sportmonks_player_id. Our own players.id has no stored mapping to that id,
 * so the bridge here is by normalised name, same two-pass (exact, then
 * unambiguous surname) strategy sportmonksFouls.ts already used to match a
 * bookmaker's own spelling against a lineup. Team-level foul profiles (the
 * crosswise opponent adjustment) are built by aggregating whichever of the 22
 * starters matched, split by our own home/away lineup - not by
 * sportmonks_team_id, which has no bridge either.
 */

import { createClient } from "@supabase/supabase-js";
import {
  fitLadder,
  solveKappa,
  decimalToFractional,
  type PlayerLadder,
  type OddsQuote,
  type LadderFit,
} from "./foulsEdge";
import {
  computePlayerRate,
  projectFixture,
  type PlayerFoulHistory,
  type SeasonFoulRow,
  type TeamFoulProfile,
  type PlayerFoulRate,
} from "./foulModel";

function client() {
  return createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    { auth: { persistSession: false } },
  );
}

/**
 * Mirrors COMPETITIONS in scripts/scrape_spreadex_player_markets.py - keys
 * must match fixtures.competition's REAL stored values, not a readable
 * guess. Caught live 2026-08-29, ~8 minutes before Tottenham v Newcastle
 * kickoff: "premier_league"/"championship" here didn't match the real
 * "soccer_epl"/"efl_championship" values, so the fixture picker silently
 * only ever showed League One (the one key that happened to match).
 */
const COMPETITION_LABELS: Record<string, string> = {
  soccer_epl: "Premier League",
  efl_championship: "Championship",
  efl_league_one: "League One",
};

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
  const supabase = client();
  const { data, error } = await supabase
    .from("fixtures")
    .select("id, competition, kickoff_at, home:teams!fixtures_home_team_id_fkey(name), away:teams!fixtures_away_team_id_fkey(name)")
    .in("competition", Object.keys(COMPETITION_LABELS))
    .gte("kickoff_at", fromISO)
    .lt("kickoff_at", toISO)
    .order("kickoff_at", { ascending: true })
    .limit(500);
  if (error) throw new Error(`fixtures: ${error.message}`);

  type Row = {
    id: number;
    competition: string;
    kickoff_at: string;
    home: { name: string } | { name: string }[] | null;
    away: { name: string } | { name: string }[] | null;
  };
  const nameOf = (t: Row["home"]) => (Array.isArray(t) ? t[0]?.name : t?.name) ?? "?";

  return ((data ?? []) as Row[]).map((f) => ({
    id: f.id,
    name: `${nameOf(f.home)} vs ${nameOf(f.away)}`,
    league: COMPETITION_LABELS[f.competition] ?? f.competition,
    kickoff: f.kickoff_at,
  }));
}

/* ========================================================================== *
 * Lineups
 * ========================================================================== */

export type LineupPlayer = {
  playerId: number | null;
  name: string;
  shirt: number | null;
  team: "home" | "away";
  formationRow: number | null;
  formationCol: number | null;
  rowWidth: number | null;
};

async function fetchLineups(
  fixtureId: number,
  homeTeamId: number,
  awayTeamId: number,
): Promise<{ players: LineupPlayer[]; confirmed: boolean }> {
  const supabase = client();
  // Latest capture only - a lineup is a point-in-time snapshot, and a late
  // change before kickoff should replace the earlier read, not merge with it.
  const { data: latest, error: latestErr } = await supabase
    .from("fixture_lineups")
    .select("captured_at")
    .eq("fixture_id", fixtureId)
    .order("captured_at", { ascending: false })
    .limit(1);
  if (latestErr) throw new Error(`fixture_lineups: ${latestErr.message}`);
  if (!latest?.length) return { players: [], confirmed: false };

  const { data, error } = await supabase
    .from("fixture_lineups")
    .select("player_id, team_id, player_name_raw, shirt_number, formation_row, formation_col, row_width")
    .eq("fixture_id", fixtureId)
    .eq("captured_at", latest[0].captured_at);
  if (error) throw new Error(`fixture_lineups: ${error.message}`);

  type Row = {
    player_id: number | null;
    team_id: number;
    player_name_raw: string;
    shirt_number: number | null;
    formation_row: number | null;
    formation_col: number | null;
    row_width: number | null;
  };
  const players: LineupPlayer[] = ((data ?? []) as Row[]).map((r) => ({
    playerId: r.player_id,
    name: r.player_name_raw,
    shirt: r.shirt_number,
    team: r.team_id === homeTeamId ? "home" : "away",
    formationRow: r.formation_row,
    formationCol: r.formation_col,
    rowWidth: r.row_width,
  }));

  const homeCount = players.filter((p) => p.team === "home").length;
  const awayCount = players.filter((p) => p.team === "away").length;
  return { players, confirmed: homeCount >= 9 && awayCount >= 9 };
}

/* ========================================================================== *
 * Ladders (Fouls Committed / Tackles) from fixture_player_props
 * ========================================================================== */

type PropRow = {
  player_name_raw: string;
  player_id: number | null;
  market: string;
  price: number;
  line: number;
  fetched_at: string;
};

async function fetchLatestProps(fixtureId: number, markets: string[]): Promise<PropRow[]> {
  const supabase = client();
  const { data, error } = await supabase
    .from("fixture_player_props")
    .select("player_name_raw, player_id, market, price, line, fetched_at")
    .eq("fixture_id", fixtureId)
    .in("market", markets)
    .order("fetched_at", { ascending: false })
    .limit(2000);
  if (error) throw new Error(`fixture_player_props: ${error.message}`);

  // Append-only table - keep only the most recent quote per (market, name, line).
  const latest = new Map<string, PropRow>();
  for (const r of (data ?? []) as PropRow[]) {
    const key = `${r.market}|${r.player_name_raw}|${r.line}`;
    if (!latest.has(key)) latest.set(key, r);
  }
  return [...latest.values()];
}

/**
 * A stable cross-market identity for one real player, used to join the
 * Fouls Committed ladder, the Tackles ladder and the lineup together.
 *
 * `fixture_lineups.player_name_raw` and `fixture_player_props.player_name_raw`
 * are two INDEPENDENT scrapes of Spreadex's own text (List View's lineup
 * spelling vs. each ladder's own price-button label) - they are not
 * guaranteed to agree character-for-character, and a first version of this
 * function keyed players by that raw name directly. Live check on
 * Bournemouth v Everton (2026-08-29, 22 confirmed starters, 28 real Fouls
 * Committed rows already in the DB) found only 3 of them actually joined -
 * the rest silently fell out as two "different" players because the two
 * scrapes spelled the same name differently.
 *
 * Both tables already carry a `player_id` resolved against our OWN
 * `players` table by `resolve_player_id()` in the scraper - that is the
 * real, exact bridge, and normalised name is only a fallback for the rows
 * that resolve_player_id itself couldn't place (reported as "unmatched
 * player name(s)" by the scraper - a real but small minority).
 */
function identityKey(playerId: number | null, rawName: string): string {
  return playerId != null ? `id:${playerId}` : `name:${normalise(rawName)}`;
}

function buildLadders(
  rows: PropRow[],
  market: string,
  lineup: LineupPlayer[],
): PlayerLadder[] {
  const byKey = new Map<string, { team: "home" | "away" | null; quotes: Map<number, number> }>();
  const lineupById = new Map<number, LineupPlayer>();
  const lineupByNormName = new Map<string, LineupPlayer>();
  for (const p of lineup) {
    if (p.playerId != null) lineupById.set(p.playerId, p);
    lineupByNormName.set(normalise(p.name), p);
  }

  for (const r of rows) {
    if (r.market !== market) continue;
    const key = identityKey(r.player_id, r.player_name_raw);
    const lineupMatch = r.player_id != null ? lineupById.get(r.player_id) : lineupByNormName.get(normalise(r.player_name_raw));
    const entry = byKey.get(key) ?? {
      team: lineupMatch?.team ?? null,
      quotes: new Map<number, number>(),
    };
    entry.quotes.set(r.line, r.price);
    byKey.set(key, entry);
  }

  const maxLine = Math.max(0, ...rows.map((r) => r.line));
  const ladders: PlayerLadder[] = [];
  for (const [key, entry] of byKey) {
    const quotes: OddsQuote[] = [];
    for (let line = 1; line <= maxLine; line++) {
      const decimal = entry.quotes.get(line) ?? null;
      const usable = decimal != null && isFinite(decimal) && decimal > 1;
      quotes.push({
        line,
        fractional: usable ? decimalToFractional(decimal!) : null,
        decimal: usable ? decimal : null,
        suspended: !usable,
      });
    }
    // `.name` carries the identity KEY here, not a display name - see
    // fetchLiveBoard's playerNameByKey for the human-readable lookup. This
    // keeps fitSingleMarket's fits map (keyed by `.name`) joinable across
    // both ladders and the lineup by the same stable identity.
    ladders.push({ name: key, team: entry.team ?? "unknown", quotes });
  }
  return ladders;
}

/* ========================================================================== *
 * Fitting one market's ladder set (adapted from fitBoard, which assumes two
 * markets exist at once - this project only ever has one at a time now)
 * ========================================================================== */

const NB_SIZES = [0.8, 1.0, 1.3, 1.6, 2.0, 2.5, 3.0, 4.0, 5.0, 6.5, 8.0, 10.0, 14.0, 20.0, 35.0, 60.0];
export const DEFAULT_ASSUMED_OVERROUND = 9;

export function fitSingleMarket(
  ladders: PlayerLadder[],
  assumedOverround: number = DEFAULT_ASSUMED_OVERROUND,
): { size: number; kappa: number; fits: Map<string, LadderFit> } {
  let best = { size: 4, kappa: 0.95, loss: Infinity };
  for (const size of NB_SIZES) {
    const kappa = solveKappa(ladders, "committed", size, assumedOverround);
    let sum = 0;
    let n = 0;
    for (const l of ladders) {
      const fit = fitLadder(l, "committed", size, kappa);
      if (!fit) continue;
      sum += fit.rmse * fit.rmse * fit.rungs.length;
      n += fit.rungs.length;
    }
    const loss = n > 0 ? sum / n : Infinity;
    if (loss < best.loss) best = { size, kappa, loss };
  }

  const fits = new Map<string, LadderFit>();
  for (const l of ladders) {
    const fit = fitLadder(l, "committed", best.size, best.kappa);
    if (fit) fits.set(l.name, fit);
  }
  return { size: best.size, kappa: best.kappa, fits };
}

/* ========================================================================== *
 * Total Cards O/U -> margin (replaces sportmonksFouls' deriveOverround,
 * sourced from Spreadex's own two-way market instead of bet365 shots O/U)
 * ========================================================================== */

export function deriveCardsOverround(rows: PropRow[]): { value: number | null; sampleSize: number } {
  const byLine = new Map<number, { over?: number; under?: number }>();
  for (const r of rows) {
    if (r.market === "Total Cards Over") byLine.set(r.line, { ...byLine.get(r.line), over: r.price });
    if (r.market === "Total Cards Under") byLine.set(r.line, { ...byLine.get(r.line), under: r.price });
  }
  const overrounds: number[] = [];
  for (const { over, under } of byLine.values()) {
    if (over && under && over > 1 && under > 1) overrounds.push((1 / over + 1 / under - 1) * 100);
  }
  if (!overrounds.length) return { value: null, sampleSize: 0 };
  const sorted = [...overrounds].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  const value = sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
  return { value, sampleSize: overrounds.length };
}

/* ========================================================================== *
 * Historical model, bridged by name (see module docstring)
 * ========================================================================== */

function normalise(s: string): string {
  return s
    .toLowerCase()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^a-z ]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

type FoulStatRow = {
  sportmonks_player_id: number;
  season_id: number;
  league_id: number;
  season_name: string | null;
  player_name: string;
  position_id: number | null;
  minutes: number;
  appearances: number;
  lineups: number;
  fouls: number;
  fouls_drawn: number;
};

async function fetchAllFoulStats(): Promise<FoulStatRow[]> {
  const supabase = client();
  const rows: FoulStatRow[] = [];
  for (let page = 0; page < 20; page++) {
    const { data, error } = await supabase
      .from("player_foul_stats")
      .select(
        "sportmonks_player_id,season_id,league_id,season_name,player_name,position_id,minutes,appearances,lineups,fouls,fouls_drawn",
      )
      .range(page * 1000, page * 1000 + 999);
    if (error) throw new Error(`player_foul_stats: ${error.message}`);
    rows.push(...((data ?? []) as FoulStatRow[]));
    if (!data || data.length < 1000) break;
  }
  return rows;
}

export type ModelledPlayer = {
  playerName: string;
  team: "home" | "away";
  /** Expected fouls committed in this fixture, per our historical model. */
  committedMu: number;
  confidence: number;
  effectiveNinetys: number;
  matched: boolean;
};

async function buildModel(lineup: LineupPlayer[]): Promise<{ players: ModelledPlayer[]; coverage: { covered: number; requested: number } }> {
  const statRows = await fetchAllFoulStats();

  // Newest season name in the table drives recency weighting - avoids a
  // hardcoded season id that goes stale every August (same approach as
  // foulModelStore.ts).
  const byRecency = [...statRows].sort((a, b) => (b.season_name ?? "").localeCompare(a.season_name ?? ""));
  const newestName = byRecency[0]?.season_name ?? null;
  const currentSeasonIds = new Set(statRows.filter((s) => s.season_name === newestName).map((s) => s.season_id));

  const byNormName = new Map<string, PlayerFoulHistory>();
  for (const r of statRows) {
    const key = normalise(r.player_name);
    if (!key) continue;
    let entry = byNormName.get(key);
    if (!entry) {
      entry = { playerId: r.sportmonks_player_id, playerName: r.player_name, positionId: r.position_id, seasons: [] };
      byNormName.set(key, entry);
    }
    const season: SeasonFoulRow = {
      seasonId: r.season_id,
      seasonName: r.season_name,
      leagueId: r.league_id,
      minutes: r.minutes,
      appearances: r.appearances,
      lineups: r.lineups,
      fouls: r.fouls,
      foulsDrawn: r.fouls_drawn,
    };
    entry.seasons.push(season);
    if (entry.positionId == null && r.position_id != null) entry.positionId = r.position_id;
  }

  // Two-pass match, same discipline as sportmonksFouls.ts's laddersFrom:
  // exact normalised name first (claims the slot), then unambiguous surname
  // only against names nobody has claimed - never guess when it could
  // collide two real players onto one history.
  const claimed = new Set<string>();
  const rateFor = (lineupName: string): PlayerFoulRate | null => {
    const exact = normalise(lineupName);
    let history = byNormName.get(exact);
    let key = exact;
    if (!history || claimed.has(key)) {
      const surname = exact.split(" ").slice(-1)[0];
      if (surname && surname.length >= 3) {
        const candidates = [...byNormName.entries()].filter(
          ([k]) => !claimed.has(k) && k.split(" ").slice(-1)[0] === surname,
        );
        if (candidates.length === 1) [key, history] = candidates[0];
        else history = undefined;
      } else {
        history = undefined;
      }
    }
    if (!history) return null;
    claimed.add(key);
    return computePlayerRate(history, currentSeasonIds);
  };

  const rates = new Map<string, PlayerFoulRate>(); // by lineup player name
  for (const p of lineup) {
    const rate = rateFor(p.name);
    if (rate) rates.set(p.name, rate);
  }

  // Team profiles from whichever starters matched, grouped by OUR home/away
  // lineup assignment - not sportmonks_team_id, which has no bridge to our
  // own team ids.
  const teamAgg: Record<"home" | "away", { minutes: number; fouls: number; drawn: number }> = {
    home: { minutes: 0, fouls: 0, drawn: 0 },
    away: { minutes: 0, fouls: 0, drawn: 0 },
  };
  for (const p of lineup) {
    const rate = rates.get(p.name);
    if (!rate || rate.rawCommittedPer90 == null) continue;
    const ninetys = rate.effectiveNinetys;
    teamAgg[p.team].minutes += ninetys * 90;
    teamAgg[p.team].fouls += rate.committedPer90 * ninetys;
    teamAgg[p.team].drawn += rate.drawnPer90 * ninetys;
  }
  const teamProfile = (side: "home" | "away"): TeamFoulProfile | null => {
    const agg = teamAgg[side];
    const ninetys = agg.minutes / 90;
    if (ninetys <= 0) return null;
    return { teamId: 0, committedPer90: agg.fouls / ninetys, drawnPer90: agg.drawn / ninetys, ninetys };
  };
  const opponentOf: Record<"home" | "away", TeamFoulProfile | null> = {
    home: teamProfile("away"),
    away: teamProfile("home"),
  };

  const players: ModelledPlayer[] = lineup.map((p) => {
    const rate = rates.get(p.name);
    if (!rate) {
      return { playerName: p.name, team: p.team, committedMu: 0, confidence: 0, effectiveNinetys: 0, matched: false };
    }
    const projected = projectFixture(rate, p.team, opponentOf[p.team]);
    return {
      playerName: p.name,
      team: p.team,
      committedMu: projected.committed,
      confidence: projected.confidence,
      effectiveNinetys: projected.effectiveNinetys,
      matched: true,
    };
  });

  return { players, coverage: { covered: rates.size, requested: lineup.length } };
}

/* ========================================================================== *
 * Combined
 * ========================================================================== */

export type PlayerBoardRow = {
  playerName: string;
  /** "unknown" when the ladders posted before lineups did - no confirmed XI yet to assign a side from. */
  team: "home" | "away" | "unknown";
  shirt: number | null;
  foulsCommitted: LadderFit | null;
  tackles: LadderFit | null;
  model: ModelledPlayer | null;
  /** (model mu - market fair mu) / market fair mu * 100. Positive = model expects more fouls than the market's own fitted rate - the Fouls Committed overs look good value. */
  edgePct: number | null;
};

export type SpreadexBoardResult = {
  fixtureId: number;
  fixtureName: string;
  home: string;
  away: string;
  kickoff: string | null;
  lineupsConfirmed: boolean;
  hasFoulsMarkets: boolean;
  hasTacklesMarkets: boolean;
  cardsOverround: number | null;
  cardsOverroundSample: number;
  modelCoverage: { covered: number; requested: number };
  players: PlayerBoardRow[];
  notes: string[];
};

export async function fetchLiveBoard(fixtureId: number): Promise<SpreadexBoardResult> {
  const supabase = client();
  const notes: string[] = [];

  const { data: fixtureRow, error: fixtureErr } = await supabase
    .from("fixtures")
    .select("id, competition, kickoff_at, home_team_id, away_team_id, home:teams!fixtures_home_team_id_fkey(name), away:teams!fixtures_away_team_id_fkey(name)")
    .eq("id", fixtureId)
    .single();
  if (fixtureErr || !fixtureRow) throw new Error(`fixtures: ${fixtureErr?.message ?? "not found"}`);

  type FixtureJoin = {
    id: number;
    kickoff_at: string;
    home_team_id: number;
    away_team_id: number;
    home: { name: string } | { name: string }[] | null;
    away: { name: string } | { name: string }[] | null;
  };
  const f = fixtureRow as FixtureJoin;
  const nameOf = (t: FixtureJoin["home"]) => (Array.isArray(t) ? t[0]?.name : t?.name) ?? "?";
  const homeName = nameOf(f.home);
  const awayName = nameOf(f.away);

  const [{ players: lineup, confirmed }, propRows] = await Promise.all([
    fetchLineups(f.id, f.home_team_id, f.away_team_id),
    fetchLatestProps(f.id, ["Fouls Committed", "Tackles", "Total Cards Over", "Total Cards Under"]),
  ]);

  if (!confirmed) {
    notes.push("Lineups not confirmed yet (Spreadex posts them about an hour before kickoff). Ladders below still work; the fouls model needs a confirmed XI to run.");
  }

  const foulsRows = propRows.filter((r) => r.market === "Fouls Committed");
  const tacklesRows = propRows.filter((r) => r.market === "Tackles");
  const hasFoulsMarkets = foulsRows.length > 0;
  const hasTacklesMarkets = tacklesRows.length > 0;
  if (!hasFoulsMarkets) notes.push("No Fouls Committed market posted for this fixture yet - Spreadex opens it in a narrow pre-kickoff window.");
  if (!hasTacklesMarkets) notes.push("No Tackles market posted for this fixture yet - same narrow pre-kickoff window as Fouls Committed.");

  const foulsLadders = buildLadders(foulsRows, "Fouls Committed", lineup);
  const tacklesLadders = buildLadders(tacklesRows, "Tackles", lineup);
  const foulsFit = foulsLadders.length ? fitSingleMarket(foulsLadders) : null;
  const tacklesFit = tacklesLadders.length ? fitSingleMarket(tacklesLadders) : null;

  const cardsOverround = deriveCardsOverround(propRows);
  if (cardsOverround.value == null) {
    notes.push("No Total Cards Over/Under on this fixture to measure the margin from.");
  }

  let modelPlayers: ModelledPlayer[] = [];
  let modelCoverage = { covered: 0, requested: 0 };
  if (confirmed) {
    try {
      const model = await buildModel(lineup);
      modelPlayers = model.players;
      modelCoverage = model.coverage;
      if (modelCoverage.requested > 0 && modelCoverage.covered < modelCoverage.requested * 0.6) {
        notes.push(`Foul history covers only ${modelCoverage.covered} of ${modelCoverage.requested} starters - the model comparison will be weak for the rest.`);
      }
    } catch (err) {
      notes.push(`Historical foul model unavailable: ${(err as Error).message}`);
    }
  }
  // buildModel() only ever runs over `lineup`, so it's keyed by the
  // lineup's own name spelling - safe to look up directly once we resolve
  // each identity key back to its lineup entry below.
  const modelByLineupName = new Map(modelPlayers.map((m) => [m.playerName, m]));

  // Union lineup players with ladder players BY IDENTITY KEY (see
  // identityKey/buildLadders above), not by raw name - Fouls Committed/
  // Tackles can post before lineups do (confirmed live 2026-08-29, ~8 min
  // before Tottenham v Newcastle kickoff: both markets had real prices,
  // lineups still unconfirmed), and a raw-name union both missed that case
  // AND silently failed to join most confirmed starters to their own
  // ladder rows once lineups did land, because the lineup scrape and the
  // ladder scrape don't always spell a name identically.
  const lineupByKey = new Map(lineup.map((p) => [identityKey(p.playerId, p.name), p]));
  // Ladder-only fallback display name (a real player_name_raw, not the
  // identity key that LadderFit.name now carries - see buildLadders).
  const rawNameByKey = new Map<string, string>();
  for (const r of [...foulsRows, ...tacklesRows]) {
    const key = identityKey(r.player_id, r.player_name_raw);
    if (!rawNameByKey.has(key)) rawNameByKey.set(key, r.player_name_raw);
  }
  const allKeys = new Set<string>([...lineupByKey.keys(), ...foulsLadders.map((l) => l.name), ...tacklesLadders.map((l) => l.name)]);

  const players: PlayerBoardRow[] = [...allKeys].map((key) => {
    const p = lineupByKey.get(key);
    const fc = foulsFit?.fits.get(key) ?? null;
    const tk = tacklesFit?.fits.get(key) ?? null;
    const model = p ? (modelByLineupName.get(p.name) ?? null) : null;
    const team: "home" | "away" | "unknown" = p?.team ?? "unknown";
    // Display name: prefer the lineup's own spelling once one exists,
    // otherwise fall back to the raw name a ladder actually posted under.
    const displayName = p?.name ?? rawNameByKey.get(key) ?? key.replace(/^(id:|name:)/, "");
    let edgePct: number | null = null;
    if (fc && model && model.matched && fc.mu > 0) {
      edgePct = ((model.committedMu - fc.mu) / fc.mu) * 100;
    }
    return { playerName: displayName, team, shirt: p?.shirt ?? null, foulsCommitted: fc, tackles: tk, model, edgePct };
  });

  return {
    fixtureId: f.id,
    fixtureName: `${homeName} vs ${awayName}`,
    home: homeName,
    away: awayName,
    kickoff: f.kickoff_at,
    lineupsConfirmed: confirmed,
    hasFoulsMarkets,
    hasTacklesMarkets,
    cardsOverround: cardsOverround.value,
    cardsOverroundSample: cardsOverround.sampleSize,
    modelCoverage,
    players,
    notes,
  };
}
