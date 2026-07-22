"use server";

import { revalidatePath } from "next/cache";
import { createServiceSupabaseClient } from "@/lib/supabaseServiceClient";

/**
 * Tournament odds for Hail Mary Golf - manually sourced, same reasoning
 * as course history. The Odds API (already used for football/NFL) only
 * covers the 4 major championships for golf, outright-winner only - no
 * regular-week PGA Tour coverage at all (confirmed live against their
 * /sports endpoint with all=true). A dedicated golf-odds subscription
 * would cover it, but not worth paying for just a once-a-week "rough
 * idea of the market" - a bookmaker/odds-aggregator page (e.g.
 * oddschecker's real "3M Open Winner"/"Top 20 Finish" pages) is free to
 * view, so the workflow is: open that page, copy the player+odds column,
 * paste it here, pick the market it's for.
 *
 * Deliberately one market per paste (win/top5/top10/top20) rather than
 * trying to parse a multi-column table generically - bookmaker sites
 * themselves split markets onto separate pages this way, so it maps
 * directly onto how the source data actually looks, and avoids guessing
 * at an unpredictable multi-column paste format.
 *
 * Only matches against EXISTING golfers, same as course history - never
 * creates one, since a bookmaker's outright field is broader than any
 * single FanTeam pool and a wrong-created row risks colliding with a
 * later real FanTeam-sourced name variant.
 */

const MARKETS = ["win", "top5", "top10", "top20"] as const;
type Market = (typeof MARKETS)[number];

function compact(name: string): string {
  return name.toLowerCase().replace(/[^a-z]/g, "");
}

function surnameKey(fullName: string): string {
  const parts = fullName.trim().split(" ");
  return compact(parts[parts.length - 1]);
}

// Recognizes fractional (11/1, 9/2), American (+1200, -150), decimal
// (12.0, 3.5), and "evens"/"evs" tokens - the three formats a bookmaker
// or aggregator might display, in whatever order they appear on a line.
const ODDS_TOKEN = /^(evens|evs|\d+\/\d+|[+-]\d+(\.\d+)?|\d+\.\d+)$/i;

function toDecimalOdds(token: string): number | null {
  const t = token.trim().toLowerCase();
  if (t === "evens" || t === "evs") return 2.0;
  const fractional = t.match(/^(\d+)\/(\d+)$/);
  if (fractional) {
    const num = Number(fractional[1]);
    const den = Number(fractional[2]);
    if (den <= 0) return null;
    return 1 + num / den;
  }
  const american = t.match(/^([+-]\d+(?:\.\d+)?)$/);
  if (american) {
    const n = Number(american[1]);
    if (!Number.isFinite(n) || n === 0) return null;
    return n > 0 ? 1 + n / 100 : 1 + 100 / Math.abs(n);
  }
  const decimal = Number(t);
  if (Number.isFinite(decimal) && decimal > 1) return decimal;
  return null;
}

function parseOddsLine(line: string): { name: string; decimalOdds: number } | null {
  const tokens = line.trim().split(/\s+/);
  if (tokens.length < 2) return null;

  const oddsValues: number[] = [];
  let splitIdx = tokens.length;
  for (let i = tokens.length - 1; i >= 0; i--) {
    if (ODDS_TOKEN.test(tokens[i])) {
      const dec = toDecimalOdds(tokens[i]);
      if (dec !== null) oddsValues.unshift(dec);
      splitIdx = i;
    } else {
      break;
    }
  }
  if (oddsValues.length === 0) return null;

  const name = tokens.slice(0, splitIdx).join(" ").trim();
  if (!name) return null;

  // Multiple bookmaker quotes on one row (an aggregator's comparison
  // table) - average them into one representative figure rather than
  // taking the single best price, which is an outlier by definition.
  const decimalOdds = oddsValues.reduce((a, b) => a + b, 0) / oddsValues.length;
  return { name, decimalOdds };
}

export type OddsImportResult = {
  tournamentName: string;
  market: Market;
  rowsParsed: number;
  matched: number;
  unmatched: string[];
};

export async function importTournamentOdds(
  tournamentId: number,
  market: string,
  pastedText: string
): Promise<{ result?: OddsImportResult; error?: string }> {
  if (!MARKETS.includes(market as Market)) return { error: `Unknown market "${market}".` };
  if (!tournamentId) return { error: "Select a tournament first." };

  const lines = pastedText.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  if (lines.length === 0) return { error: "Paste some player + odds lines first." };

  const supabase = createServiceSupabaseClient();

  const { data: tournament, error: tError } = await supabase
    .from("golf_tournaments")
    .select("id, name")
    .eq("id", tournamentId)
    .single();
  if (tError || !tournament) return { error: `Tournament not found: ${tError?.message}` };

  const { data: golferRows } = await supabase.from("golfers").select("id, full_name");
  const golfers = (golferRows ?? []).map((g) => ({ id: g.id as number, full_name: g.full_name as string }));

  let matched = 0;
  let rowsParsed = 0;
  const unmatched: string[] = [];

  for (const line of lines) {
    const parsed = parseOddsLine(line);
    if (!parsed) continue;
    rowsParsed += 1;

    const liveCompact = compact(parsed.name);
    const exact = golfers.filter((g) => compact(g.full_name) === liveCompact);
    let golferId: number | null = null;
    if (exact.length === 1) {
      golferId = exact[0].id;
    } else if (exact.length === 0) {
      const key = surnameKey(parsed.name);
      const fuzzy = golfers.filter((g) => surnameKey(g.full_name) === key);
      if (fuzzy.length === 1) golferId = fuzzy[0].id;
    }

    if (golferId) matched += 1;
    else unmatched.push(parsed.name);

    await supabase.from("golf_tournament_odds").upsert(
      {
        tournament_id: tournamentId,
        golfer_id: golferId,
        raw_player_name: parsed.name,
        market,
        decimal_odds: Math.round(parsed.decimalOdds * 100) / 100,
        implied_probability: Math.round((1 / parsed.decimalOdds) * 10000) / 10000,
        source: "bookmaker",
        updated_at: new Date().toISOString(),
      },
      { onConflict: "tournament_id,raw_player_name,market" }
    );
  }

  revalidatePath("/golf");
  revalidatePath("/golf/odds");
  revalidatePath("/golf/rankings");

  return {
    result: { tournamentName: tournament.name as string, market: market as Market, rowsParsed, matched, unmatched },
  };
}
