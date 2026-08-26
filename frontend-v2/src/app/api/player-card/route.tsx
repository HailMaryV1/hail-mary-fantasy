import { readFile } from "fs/promises";
import path from "path";
import { NextRequest } from "next/server";
import { ImageResponse } from "next/og";
import { createAuthServerClient } from "@/lib/supabaseServerClient";
import { fetchEngineExplanation, fetchEngineExplanationForGameweek, competitionLabel } from "@/lib/engineExplainability";
import { getKitImage } from "@/lib/kitImages";
import { hasBudget } from "@/lib/gameConfig";
import { getPlayerProjectionTrend } from "@/lib/projectionTrend";
import { buildPlayerCardElement, PLAYER_CARD_SIZE, type PlayerCardTargetScore } from "@/lib/playerCard";

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

type TeamRow = { team_id: number };

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
  // Explicit gameweek override (EFL Fantasy only, 2026-08-21 user report -
  // same mismatch as PlayerInfoPanel.tsx: the shared player_projection_summary
  // view's own current_gw guess can disagree with EFL Fantasy's per-player
  // locking, so the downloaded card showed a different fixture/projection
  // than the panel the user just looked at). Every other game's download
  // link omits this param, unchanged.
  const gameweekParam = request.nextUrl.searchParams.get("gameweek");
  const gameweek = gameweekParam ? Number(gameweekParam) : NaN;
  // Target Score horizon (2026-08-23 user request - /ratings' horizon
  // selector) - only present when the download was triggered from that
  // page. Absent everywhere else, which keeps the card's existing trend-
  // chart panel unchanged for every other download site.
  const horizonParam = request.nextUrl.searchParams.get("horizon");
  const horizon = horizonParam ? Number(horizonParam) : NaN;

  const supabase = await createAuthServerClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return new Response("Not signed in.", { status: 401 });

  const data = Number.isFinite(gameweek)
    ? await fetchEngineExplanationForGameweek(supabase, gameSlug, gamePlayerId, gameweek)
    : await fetchEngineExplanation(supabase, gameSlug, gamePlayerId);
  if (!data) return new Response("No projection available for this player yet.", { status: 404 });

  const { data: teamRow } = await supabase
    .from("game_player_pool")
    .select("team_id")
    .eq("game_slug", gameSlug)
    .eq("game_player_id", gamePlayerId)
    .maybeSingle<TeamRow>();

  // 2026-08-20 user request ("Find the players team win probability and
  // put that on there... C/S probability for keeper and defenders...
  // goal and/or assist probability on mids and forwards"). Goal/assist/
  // clean-sheet come straight off the engine's own Bookmaker Intelligence
  // blend (data.moduleDetail) - already computed, no new query. Team win
  // probability isn't part of that per-player blend (it's a team-level
  // figure), so it's the one extra lookup here: team_fixture_difficulty
  // is keyed by (game_id, team_id, fixture_id) - the same real fixture can
  // carry different rows per fantasy game (separate compute runs), so the
  // fantasy_games.id lookup below isn't optional.
  let teamWinProbability: number | null = null;
  if (teamRow?.team_id != null && data.primaryFixture) {
    const { data: gameRow } = await supabase.from("fantasy_games").select("id").eq("slug", gameSlug).maybeSingle<{ id: number }>();
    if (gameRow) {
      const { data: difficultyRow } = await supabase
        .from("team_fixture_difficulty")
        .select("team_win_prob")
        .eq("game_id", gameRow.id)
        .eq("team_id", teamRow.team_id)
        .eq("fixture_id", data.primaryFixture.fixtureId)
        .maybeSingle<{ team_win_prob: number | string }>();
      teamWinProbability = difficultyRow ? Number(difficultyRow.team_win_prob) : null;
    }
  }
  // clean_sheet_60min's finalRate is already a bounded probability (0-1).
  // goal/assist's finalRate is an expected COUNT for the fixture (can
  // legitimately exceed 1 for a high-volume striker at home to a weak
  // side - e.g. Haaland's real finalRate here is 1.19) - converting via
  // the standard Poisson P(at least one) = 1 - e^-rate turns that into an
  // honest bounded probability instead of a ">100%" figure, same
  // Poisson-calibration approach scripts/compute_expected_goals.py
  // already uses elsewhere in this engine.
  const toProbability = (rate: number) => 1 - Math.exp(-rate);
  const cleanSheetProbability = data.moduleDetail?.clean_sheet_60min?.finalRate ?? null;
  const goalProbability = data.moduleDetail?.goal ? toProbability(data.moduleDetail.goal.finalRate) : null;
  const assistProbability = data.moduleDetail?.assist ? toProbability(data.moduleDetail.assist.finalRate) : null;

  // 2026-08-21 user addition: a 4th slot on the real card background art
  // (card-bg.png) specifically for this - reuses the exact same helper
  // PlayerInfoPanel's own trend chart already calls (lib/projectionTrend.ts)
  // - same dedup-by-gameweek semantics, same 5-gameweek default window, so
  // the card never disagrees with what the player's own detail page shows.
  const trend = await getPlayerProjectionTrend(supabase, gamePlayerId, data.gameweek ?? 1, 5);

  let targetScoreCard: PlayerCardTargetScore | null = null;
  if (Number.isFinite(horizon) && data.gameweek != null) {
    const { data: tsRow } = await supabase
      .from("target_scores")
      .select("target_score, form_rating, fixture_difficulty_rating, fixture_quantity_rating, live_odds_rating, start_gameweek, end_gameweek, inputs")
      .eq("game_player_id", gamePlayerId)
      .eq("horizon", horizon)
      .eq("start_gameweek", data.gameweek)
      .maybeSingle<{
        target_score: number;
        form_rating: number | null;
        fixture_difficulty_rating: number | null;
        fixture_quantity_rating: number | null;
        live_odds_rating: number | null;
        start_gameweek: number;
        end_gameweek: number;
        inputs: { window_fixtures?: { opponent_team_name: string | null; is_home: boolean; difficulty_raw: number | null }[] };
      }>();
    if (tsRow) {
      targetScoreCard = {
        horizon,
        startGameweek: tsRow.start_gameweek,
        endGameweek: tsRow.end_gameweek,
        targetScore: Number(tsRow.target_score),
        formRating: tsRow.form_rating,
        fixtureDifficultyRating: tsRow.fixture_difficulty_rating,
        fixtureQuantityRating: tsRow.fixture_quantity_rating,
        liveOddsRating: tsRow.live_odds_rating,
        windowFixtures: (tsRow.inputs?.window_fixtures ?? []).map((f) => ({
          opponentTeamName: f.opponent_team_name,
          isHome: f.is_home,
          difficultyRaw: f.difficulty_raw,
        })),
      };
    }
  }

  const [logoDataUri, kitDataUri, backgroundDataUri, oswaldMedium, oswaldBold] = await Promise.all([
    loadPublicImageAsDataUri("logo.png"),
    (() => {
      const kitPath = getKitImage(data.teamName);
      return kitPath ? loadPublicImageAsDataUri(kitPath.replace(/^\//, "")) : Promise.resolve(null);
    })(),
    loadPublicImageAsDataUri("card-bg.png"),
    loadFont("Oswald-Medium.ttf"),
    loadFont("Oswald-Bold.ttf"),
  ]);

  return new ImageResponse(
    buildPlayerCardElement({
      fullName: data.fullName,
      teamName: data.teamName,
      position: data.position,
      price: data.price,
      hasBudget: hasBudget(gameSlug),
      gameweek: data.gameweek,
      finalScore: data.finalScore,
      rating: data.rating,
      confidenceLabel: data.dataConfidence.label,
      logoDataUri,
      kitDataUri,
      backgroundDataUri,
      primaryFixture: data.primaryFixture,
      competitionLabel,
      trend,
      teamWinProbability,
      cleanSheetProbability,
      goalProbability,
      assistProbability,
      targetScore: targetScoreCard,
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
