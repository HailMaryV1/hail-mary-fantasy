import { readFile } from "fs/promises";
import path from "path";
import { NextRequest } from "next/server";
import { ImageResponse } from "next/og";
import { createAuthServerClient } from "@/lib/supabaseServerClient";
import { fetchEngineExplanation, competitionLabel } from "@/lib/engineExplainability";
import { getKitImage } from "@/lib/kitImages";
import { buildPlayerCardElement, PLAYER_CARD_SIZE } from "@/lib/playerCard";

export const runtime = "nodejs";

async function loadPublicImageAsDataUri(relativePath: string): Promise<string | null> {
  try {
    const buf = await readFile(path.join(process.cwd(), "public", relativePath));
    const ext = relativePath.endsWith(".png") ? "png" : "jpeg";
    return `data:image/${ext};base64,${buf.toString("base64")}`;
  } catch {
    return null;
  }
}

async function loadFont(fileName: string): Promise<ArrayBuffer> {
  const buf = await readFile(path.join(process.cwd(), "public", "fonts", fileName));
  return buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength) as ArrayBuffer;
}

type RealStatsRow = {
  real_total_points: number | string | null;
  real_goals: number | null;
  real_assists: number | null;
  real_clean_sheets: number | null;
  real_saves: number | null;
  real_tackles: number | null;
  real_appearances: number | null;
  last_gw: number | null;
  last_gw_points: number | string | null;
};

/**
 * Shareable "Hail Mary Projection Card" PNG - 2026-08-20 user request
 * ("New feature... which will help me on my socials"). No real player
 * photo data exists anywhere in this project (checked every scraper and
 * the players table) - the club Kit render (frontend-v2/public/kits/,
 * real crest artwork, same asset PlayerInfoPanel's fixture badge already
 * falls back to) stands in for "player image if applicable" instead of a
 * fabricated headshot. Those source PNGs are themselves only ~100-120px -
 * buildPlayerCardElement (lib/playerCard.ts) keeps the kit close to its
 * native size against a hand-drawn tactics-board backdrop, rather than
 * upscaling the raster far past native and looking soft. Built with
 * next/og's ImageResponse (bundled in Next.js, no new dependency) rather
 * than html2canvas - a server-rendered PNG matches this app's own navy/sky
 * palette exactly and needs no client bundle. Deliberately node runtime,
 * not edge - lets the logo/kit PNGs be read straight off disk (readFile)
 * instead of a self-referential network fetch back into this same app.
 * Element tree lives in lib/playerCard.ts (not inline JSX here) so a
 * standalone verification script can render the exact same code path
 * against real fetched data - see that file's own docstring.
 */
export async function GET(request: NextRequest) {
  const gameSlug = request.nextUrl.searchParams.get("gameSlug");
  const gamePlayerIdParam = request.nextUrl.searchParams.get("gamePlayerId");
  const gamePlayerId = gamePlayerIdParam ? Number(gamePlayerIdParam) : NaN;
  if (!gameSlug || !Number.isFinite(gamePlayerId)) {
    return new Response("Missing gameSlug or gamePlayerId.", { status: 400 });
  }

  const supabase = await createAuthServerClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return new Response("Not signed in.", { status: 401 });

  const data = await fetchEngineExplanation(supabase, gameSlug, gamePlayerId);
  if (!data) return new Response("No projection available for this player yet.", { status: 404 });

  const { data: realStatsRow } = await supabase
    .from("game_player_pool")
    .select("real_total_points, real_goals, real_assists, real_clean_sheets, real_saves, real_tackles, real_appearances, last_gw, last_gw_points")
    .eq("game_slug", gameSlug)
    .eq("game_player_id", gamePlayerId)
    .maybeSingle<RealStatsRow>();

  const [logoDataUri, kitDataUri, oswaldMedium, oswaldBold] = await Promise.all([
    loadPublicImageAsDataUri("logo.png"),
    (() => {
      const kitPath = getKitImage(data.teamName);
      return kitPath ? loadPublicImageAsDataUri(kitPath.replace(/^\//, "")) : Promise.resolve(null);
    })(),
    loadFont("Oswald-Medium.ttf"),
    loadFont("Oswald-Bold.ttf"),
  ]);

  // Same field order/priority as PlayerInfoPanel's own Fantasy Stats grid
  // (see components/PlayerInfoPanel.tsx) - a card only has room for 3
  // tiles, so this takes the first 3 the real data actually has, rather
  // than a fixed set that could be all-empty for some positions (e.g.
  // "Goals/Assists" for a keeper).
  const statTiles: [string, number | string][] = (
    [
      ["Total Pts", realStatsRow?.real_total_points],
      ["Goals", realStatsRow?.real_goals],
      ["Assists", realStatsRow?.real_assists],
      ["Clean Sheets", realStatsRow?.real_clean_sheets],
      ["Tackles", realStatsRow?.real_tackles],
      ["Saves", realStatsRow?.real_saves],
      ["Appearances", realStatsRow?.real_appearances],
    ] as [string, number | string | null | undefined][]
  )
    .filter((entry): entry is [string, number | string] => entry[1] != null)
    .slice(0, 3);

  return new ImageResponse(
    buildPlayerCardElement({
      fullName: data.fullName,
      teamName: data.teamName,
      position: data.position,
      price: data.price,
      gameweek: data.gameweek,
      finalScore: data.finalScore,
      confidenceLabel: data.dataConfidence.label,
      logoDataUri,
      kitDataUri,
      primaryFixture: data.primaryFixture,
      competitionLabel,
      lastGw: realStatsRow?.last_gw ?? null,
      lastGwPoints: realStatsRow?.last_gw_points ?? null,
      statTiles,
    }) as ConstructorParameters<typeof ImageResponse>[0],
    {
      width: PLAYER_CARD_SIZE,
      height: PLAYER_CARD_SIZE,
      fonts: [
        { name: "Oswald", data: oswaldMedium, weight: 500, style: "normal" },
        { name: "Oswald", data: oswaldBold, weight: 700, style: "normal" },
      ],
    }
  );
}
