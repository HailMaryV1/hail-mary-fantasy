import { readFile } from "fs/promises";
import path from "path";
import { NextRequest } from "next/server";
import { ImageResponse } from "next/og";
import { createAuthServerClient } from "@/lib/supabaseServerClient";
import { fetchMarketOdds, type EflCompetition } from "@/lib/marketOdds";
import { getKitImage } from "@/lib/kitImages";
import { buildMarketOddsCardElement, MARKET_ODDS_CARD_WIDTH, MARKET_ODDS_CARD_HEIGHT, type MarketOddsCardRow } from "@/lib/marketOddsCard";

export const runtime = "nodejs";

async function loadPublicImageAsDataUri(relativePath: string): Promise<string | null> {
  try {
    const buf = await readFile(path.join(process.cwd(), "public", relativePath));
    return `data:image/png;base64,${buf.toString("base64")}`;
  } catch {
    return null;
  }
}

async function loadFont(fileName: string): Promise<ArrayBuffer> {
  const buf = await readFile(path.join(process.cwd(), "public", "fonts", fileName));
  return buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength) as ArrayBuffer;
}

/**
 * Shareable "Hail Mary Market Odds Card" PNG - 2026-08-21 user request
 * ("like for the players... downloads the market card with the 3
 * categories on"), widened the same day to serve Dream Team/FanTeam/
 * Cloud FF's Premier League data too. Same next/og + lib/*Card.ts split
 * as api/player-card/route.tsx, for the same reasons (server-rendered,
 * matches the app's own navy palette exactly, no client bundle). Reuses
 * fetchMarketOdds - the exact same data the live Market Odds page
 * renders - so the card never disagrees with what's on screen.
 */
export async function GET(request: NextRequest) {
  const gameweekParam = request.nextUrl.searchParams.get("gameweek");
  const gameweek = gameweekParam ? Number(gameweekParam) : NaN;
  if (!Number.isFinite(gameweek)) {
    return new Response("Missing gameweek.", { status: 400 });
  }
  const gameSlug = request.nextUrl.searchParams.get("gameSlug");
  if (!gameSlug) {
    return new Response("Missing gameSlug.", { status: 400 });
  }
  const competitionParam = request.nextUrl.searchParams.get("competition");
  const competitionFilter: EflCompetition | "ALL" =
    competitionParam === "efl_championship" || competitionParam === "efl_league_one" || competitionParam === "efl_league_two"
      ? competitionParam
      : "ALL";

  const supabase = await createAuthServerClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return new Response("Not signed in.", { status: 401 });

  const { data: game } = await supabase.from("fantasy_games").select("id").eq("slug", gameSlug).maybeSingle();
  if (!game) return new Response("Unknown gameSlug.", { status: 400 });

  const { top5Winners, top5Goals, top5CleanSheets } = await fetchMarketOdds(gameSlug, gameweek, competitionFilter);

  const toRows = async (rows: typeof top5Winners, valueOf: (r: (typeof top5Winners)[number]) => string): Promise<MarketOddsCardRow[]> =>
    Promise.all(
      rows.map(async (r) => {
        const kitPath = getKitImage(r.teamName);
        const kitDataUri = kitPath ? await loadPublicImageAsDataUri(kitPath.replace(/^\//, "")) : null;
        return { teamName: r.teamName, kitDataUri, value: valueOf(r) };
      })
    );

  const [winners, goals, cleanSheets, backgroundDataUri, oswaldMedium, oswaldBold] = await Promise.all([
    toRows(top5Winners, (r) => `${Math.round(r.winPct)}%`),
    toRows(top5Goals, (r) => (r.expectedGoals != null ? r.expectedGoals.toFixed(2) : "-")),
    toRows(top5CleanSheets, (r) => `${Math.round(r.cleanSheetPct)}%`),
    loadPublicImageAsDataUri("market-odds-card.png"),
    loadFont("Oswald-Medium.ttf"),
    loadFont("Oswald-Bold.ttf"),
  ]);

  return new ImageResponse(
    buildMarketOddsCardElement({
      gameweek,
      backgroundDataUri,
      winners,
      goals,
      cleanSheets,
    }) as ConstructorParameters<typeof ImageResponse>[0],
    {
      width: MARKET_ODDS_CARD_WIDTH,
      height: MARKET_ODDS_CARD_HEIGHT,
      fonts: [
        { name: "Oswald", data: oswaldMedium, weight: 500, style: "normal" },
        { name: "Oswald", data: oswaldBold, weight: 700, style: "normal" },
      ],
    }
  );
}
