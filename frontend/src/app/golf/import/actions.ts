"use server";

import { revalidatePath } from "next/cache";
import { createServiceSupabaseClient } from "@/lib/supabaseServiceClient";

/**
 * Browser-triggered counterpart to scraper_fanteam_golf.py +
 * import_fanteam_golf.py - same fetch, same matching/upsert logic,
 * ported to TypeScript because this needs to run inside a Next.js server
 * action (Vercel's Node runtime, not the Python pipeline's GitHub Actions
 * runtime) so pasting a tournament URL in the browser does real work
 * immediately instead of waiting for the next offline pipeline run.
 * Deliberately kept logically identical to the Python version, including
 * two bugs found and fixed there during Phase 1/2 verification:
 *   - a golfer created earlier in THIS run must never be a fuzzy-name
 *     match candidate for a later one in the same tournament pool (every
 *     golfer in one pull is, by definition, a distinct real person).
 *   - match_count/start_count come from totalStats, not avgStats -
 *     avgStats.matchCount is always 1 in the real data (an artifact, not
 *     a real sample size).
 */

const BASE = "https://fanteam-game.api.scoutgg.net";

type RealPlayer = { id: number; lastName: string | null; sportyId: string | null; firstName: string; customName: string | null };
type PlayerChoice = {
  realPlayerId: number;
  realPlayer: RealPlayer;
  price: number | null;
  lineup: string | null;
  status: string | null;
  form: number | null;
  totalPoints: number | null;
  lastPoints: number | null;
  active: boolean;
  avgStats: Record<string, number> | null;
  totalStats: Record<string, number> | null;
};
type TournamentPayload = {
  tournament: { id: number; gameId?: number; name: string; cutRate?: string };
  matchCollection: { id: number; gameScope?: string; startTime?: string; endTime?: string };
  seasons: { league?: { name?: string }; season?: number }[];
  round: number | null;
  playerChoices: PlayerChoice[];
};

const CORE_AVG_STAT_COLUMNS: Record<string, string> = {
  made_cut_rate: "madeCut",
  birdie_rate: "birdie",
  bogey_rate: "bogey",
  eagle_rate: "eagle",
  double_bogey_rate: "doubleBogey",
  bounce_back_rate: "bounceBack",
  score_avg: "score",
  total_score_avg: "totalScore",
};
const CORE_TOTAL_STAT_COLUMNS: Record<string, string> = { match_count: "matchCount", start_count: "startCount" };

function parseTournamentId(input: string): string {
  const match = input.match(/\/participate\/(\d+)/);
  if (match) return match[1];
  const trimmed = input.trim();
  if (/^\d+$/.test(trimmed)) return trimmed;
  throw new Error(`Couldn't extract a tournament ID from "${input}" - paste a bare ID or a fanteam.com/fantasy/participate/<id> URL.`);
}

function compact(name: string): string {
  return name.toLowerCase().replace(/[^a-z]/g, "");
}

function surnameKey(fullName: string): string {
  if (fullName.includes(". ")) return compact(fullName.split(". ").slice(1).join(". "));
  const parts = fullName.split(" ");
  return compact(parts[parts.length - 1]);
}

function golferFullName(realPlayer: RealPlayer): string {
  if (!realPlayer.lastName) return realPlayer.customName || realPlayer.firstName;
  return `${realPlayer.firstName} ${realPlayer.lastName}`.trim();
}

export type ImportResult = {
  tournamentName: string;
  matchedBySportyId: number;
  matchedByName: number;
  created: number;
  ambiguous: string[];
  entriesWritten: number;
  changesDetected: number;
};

export async function importGolfTournament(urlOrId: string): Promise<{ result?: ImportResult; error?: string }> {
  let tournamentRef: string;
  try {
    tournamentRef = parseTournamentId(urlOrId);
  } catch (e) {
    return { error: e instanceof Error ? e.message : "Couldn't parse that input." };
  }

  let data: TournamentPayload;
  try {
    const resp = await fetch(`${BASE}/tournaments/${tournamentRef}/players?round=editable`, {
      headers: { "User-Agent": "Mozilla/5.0" },
      cache: "no-store",
    });
    if (!resp.ok) return { error: `FanTeam request failed: HTTP ${resp.status}` };
    data = await resp.json();
  } catch (e) {
    return { error: e instanceof Error ? `Network error: ${e.message}` : "Network error fetching FanTeam." };
  }

  const supabase = createServiceSupabaseClient();

  const { data: gameRow } = await supabase.from("fantasy_games").select("id").eq("slug", "fanteam-golf").maybeSingle();
  if (!gameRow) return { error: "fantasy_games row for 'fanteam-golf' not found - run migration 0045 first." };
  const gameId = gameRow.id as number;

  // 1. Upsert the tournament.
  const tournament = data.tournament;
  const matchCollection = data.matchCollection ?? {};
  const season = data.seasons?.[0];
  const now = new Date();
  const startTime = matchCollection.startTime ? new Date(matchCollection.startTime) : null;
  const endTime = matchCollection.endTime ? new Date(matchCollection.endTime) : null;
  const status = !startTime ? "upcoming" : now < startTime ? "upcoming" : endTime && now > endTime ? "completed" : "live";

  const { data: tournamentRow, error: tournamentError } = await supabase
    .from("golf_tournaments")
    .upsert(
      {
        game_id: gameId,
        fanteam_tournament_id: String(tournament.id),
        fanteam_game_id: String(tournament.gameId ?? matchCollection.id ?? ""),
        name: tournament.name,
        tour: season?.league?.name ?? null,
        season_year: season?.season ?? null,
        event_number: data.round,
        game_scope: matchCollection.gameScope ?? null,
        registration_time: (tournament as { registrationTime?: string }).registrationTime ?? null,
        start_time: matchCollection.startTime ?? null,
        end_time: matchCollection.endTime ?? null,
        status,
        raw: { tournament, matchCollection, seasons: data.seasons, round: data.round },
        updated_at: new Date().toISOString(),
      },
      { onConflict: "fanteam_tournament_id" }
    )
    .select("id")
    .single();
  if (tournamentError || !tournamentRow) return { error: `Failed to upsert tournament: ${tournamentError?.message}` };
  const tournamentId = tournamentRow.id as number;

  // 2. Load matching state - golfers known BEFORE this run (frozen for
  // the whole run, see module docstring), existing game_players for this
  // game, existing tournament entries (for change detection).
  const { data: golferRows } = await supabase.from("golfers").select("id, sporty_id, full_name");
  const sportyIdCache = new Map<string, number>();
  const golfers: { id: number; full_name: string }[] = [];
  for (const g of golferRows ?? []) {
    if (g.sporty_id) sportyIdCache.set(g.sporty_id, g.id);
    golfers.push({ id: g.id, full_name: g.full_name });
  }

  const { data: gamePlayerRows } = await supabase
    .from("game_players")
    .select("id, golfer_id")
    .eq("game_id", gameId)
    .not("golfer_id", "is", null);
  const gamePlayerByGolfer = new Map<number, number>();
  for (const gp of gamePlayerRows ?? []) gamePlayerByGolfer.set(gp.golfer_id as number, gp.id as number);

  const { data: existingEntryRows } = await supabase
    .from("golf_tournament_entries")
    .select("game_player_id, price, lineup, status, form, total_points")
    .eq("tournament_id", tournamentId);
  const existingEntries = new Map<number, { price: number | null; lineup: string | null; status: string | null; form: number | null; total_points: number | null }>();
  for (const e of existingEntryRows ?? []) existingEntries.set(e.game_player_id as number, e);

  function resolveGolfer(sportyId: string | null, fullName: string): { id: number | null; method: string } {
    if (sportyId && sportyIdCache.has(sportyId)) return { id: sportyIdCache.get(sportyId)!, method: "sporty_id" };

    const liveCompact = compact(fullName);
    const exact = golfers.filter((g) => compact(g.full_name) === liveCompact);
    if (exact.length === 1) return { id: exact[0].id, method: "exact_name" };
    if (exact.length > 1) return { id: null, method: "ambiguous" };

    const fuzzy = golfers.filter((g) => liveCompact.endsWith(surnameKey(g.full_name)));
    if (fuzzy.length === 1) return { id: fuzzy[0].id, method: "fuzzy_name" };
    if (fuzzy.length > 1) return { id: null, method: "ambiguous" };

    return { id: null, method: "new" };
  }

  let matchedBySportyId = 0,
    matchedByName = 0,
    created = 0,
    entriesWritten = 0,
    changesDetected = 0;
  const ambiguous: string[] = [];

  for (const pc of data.playerChoices) {
    const sportyId = pc.realPlayer.sportyId;
    const fullName = golferFullName(pc.realPlayer);
    const { id: resolvedId, method } = resolveGolfer(sportyId, fullName);

    if (resolvedId === null && method === "ambiguous") {
      ambiguous.push(fullName);
      continue;
    }

    let golferId = resolvedId;
    if (golferId === null) {
      const { data: newGolfer, error: golferError } = await supabase
        .from("golfers")
        .insert({ full_name: fullName, sporty_id: sportyId })
        .select("id")
        .single();
      if (golferError || !newGolfer) {
        ambiguous.push(`${fullName} (failed to create: ${golferError?.message})`);
        continue;
      }
      golferId = newGolfer.id as number;
      // Deliberately NOT added to sportyIdCache/golfers - see module
      // docstring: a golfer created earlier in THIS run must never
      // match-candidate a later one in the same tournament pool.
      created += 1;
    } else if (method === "sporty_id") {
      matchedBySportyId += 1;
    } else {
      matchedByName += 1;
    }

    const externalId = String(pc.realPlayerId);
    const price = pc.price;
    let gamePlayerId = gamePlayerByGolfer.get(golferId);
    if (gamePlayerId) {
      await supabase.from("game_players").update({ external_id: externalId, price, is_active: true, updated_at: new Date().toISOString() }).eq("id", gamePlayerId);
    } else {
      const { data: newGp, error: gpError } = await supabase
        .from("game_players")
        .insert({ game_id: gameId, golfer_id: golferId, external_id: externalId, position_code: "GOLF", price, is_active: true })
        .select("id")
        .single();
      if (gpError || !newGp) continue;
      gamePlayerId = newGp.id as number;
      gamePlayerByGolfer.set(golferId, gamePlayerId);
    }

    const avgStats = pc.avgStats ?? {};
    const totalStats = pc.totalStats ?? {};
    const coreValues: Record<string, number | null> = {};
    for (const [col, key] of Object.entries(CORE_AVG_STAT_COLUMNS)) coreValues[col] = avgStats[key] ?? null;
    for (const [col, key] of Object.entries(CORE_TOTAL_STAT_COLUMNS)) coreValues[col] = totalStats[key] ?? null;

    const newState = { price, lineup: pc.lineup, status: pc.status, form: pc.form, total_points: pc.totalPoints };
    const oldState = existingEntries.get(gamePlayerId);
    if (oldState) {
      const numericChanged = (a: number | null, b: number | null) => (a === null && b === null ? false : Number(a ?? 0) !== Number(b ?? 0));
      const changed =
        numericChanged(oldState.price, newState.price) ||
        numericChanged(oldState.form, newState.form) ||
        numericChanged(oldState.total_points, newState.total_points) ||
        oldState.lineup !== newState.lineup ||
        oldState.status !== newState.status;
      if (changed) {
        changesDetected += 1;
        await supabase.from("activity_log").insert({
          event_type: "score_changed",
          game_id: gameId,
          game_player_id: gamePlayerId,
          summary: `${fullName}: ${JSON.stringify(oldState)} -> ${JSON.stringify(newState)}`,
          details: { tournament_id: tournamentId, old: oldState, new: newState },
        });
      }
    }

    await supabase.from("golf_tournament_entries").upsert(
      {
        tournament_id: tournamentId,
        game_player_id: gamePlayerId,
        external_player_id: externalId,
        price,
        lineup: pc.lineup,
        status: pc.status,
        form: pc.form,
        total_points: pc.totalPoints,
        last_points: pc.lastPoints,
        active: pc.active ?? true,
        ...coreValues,
        avg_stats: avgStats,
        total_stats: totalStats,
        raw: pc,
        updated_at: new Date().toISOString(),
      },
      { onConflict: "tournament_id,game_player_id" }
    );
    entriesWritten += 1;
  }

  if (created > 0) {
    await supabase.from("activity_log").insert({
      event_type: "player_added",
      game_id: gameId,
      summary: `${created} new golfer(s) added to FanTeam Golf via "${tournament.name}" import`,
      details: { tournament_id: tournamentId, count: created },
    });
  }

  revalidatePath("/golf");
  revalidatePath("/golf/import");

  return {
    result: {
      tournamentName: tournament.name,
      matchedBySportyId,
      matchedByName,
      created,
      ambiguous,
      entriesWritten,
      changesDetected,
    },
  };
}
