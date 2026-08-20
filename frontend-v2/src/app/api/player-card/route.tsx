import { readFile } from "fs/promises";
import path from "path";
import { NextRequest } from "next/server";
import { ImageResponse } from "next/og";
import { createAuthServerClient } from "@/lib/supabaseServerClient";
import { fetchEngineExplanation, competitionLabel, confidenceTone } from "@/lib/engineExplainability";
import { getKitImage } from "@/lib/kitImages";
import { getTeamColors } from "@/lib/teamColors";

export const runtime = "nodejs";

const SIZE = 1080;

// Real Tailwind hex values (ImageResponse/satori has no Tailwind runtime -
// only inline styles reach it) - navy scale from globals.css, sky/emerald/
// amber/red from Tailwind's own default palette, same shades this app's
// className strings already reference everywhere else.
const NAVY = { 950: "#050b16", 900: "#0b1524", 800: "#14203a", 700: "#1e2e45", 500: "#46617f", 300: "#a8b8cc" };
const SKY = { 300: "#7dd3fc", 400: "#38bdf8" };
const CONFIDENCE_COLORS: Record<string, { bg: string; fg: string }> = {
  High: { bg: "#022c22", fg: "#34d399" },
  Medium: { bg: "#451a03", fg: "#fbbf24" },
  Low: { bg: "#450a0a", fg: "#f87171" },
};

async function loadPublicImageAsDataUri(relativePath: string): Promise<string | null> {
  try {
    const buf = await readFile(path.join(process.cwd(), "public", relativePath));
    const ext = relativePath.endsWith(".png") ? "png" : "jpeg";
    return `data:image/${ext};base64,${buf.toString("base64")}`;
  } catch {
    return null;
  }
}

function formatKickoff(iso: string): string {
  return new Date(iso).toLocaleString("en-GB", { weekday: "short", day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" });
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
 * fabricated headshot. Built with next/og's ImageResponse (bundled in
 * Next.js, no new dependency) rather than html2canvas - a server-rendered
 * PNG matches this app's own navy/sky palette exactly and needs no client
 * bundle. Deliberately node runtime, not edge - lets the logo/kit PNGs be
 * read straight off disk (readFile) instead of a self-referential network
 * fetch back into this same app.
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

  const [logoDataUri, kitDataUri] = await Promise.all([
    loadPublicImageAsDataUri("logo.png"),
    (() => {
      const kitPath = getKitImage(data.teamName);
      return kitPath ? loadPublicImageAsDataUri(kitPath.replace(/^\//, "")) : Promise.resolve(null);
    })(),
  ]);

  const confidence = CONFIDENCE_COLORS[data.dataConfidence.label] ?? CONFIDENCE_COLORS.Low;

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

  const opponentColors = data.primaryFixture?.opponentTeamName ? getTeamColors(data.primaryFixture.opponentTeamName) : null;

  return new ImageResponse(
    (
      <div
        style={{
          width: "100%",
          height: "100%",
          display: "flex",
          flexDirection: "column",
          backgroundColor: NAVY[950],
          fontFamily: "sans-serif",
          padding: 56,
        }}
      >
        {/* Header */}
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
          <div style={{ display: "flex", alignItems: "center", gap: 14 }}>
            {logoDataUri && <img src={logoDataUri} width={44} height={45} />}
            <span style={{ fontSize: 28, fontWeight: 700, color: "#ffffff", letterSpacing: 1 }}>HAIL MARY</span>
          </div>
          {data.gameweek != null && (
            <span
              style={{
                fontSize: 22,
                fontWeight: 700,
                color: NAVY[300],
                backgroundColor: NAVY[800],
                borderRadius: 999,
                padding: "8px 20px",
              }}
            >
              GW{data.gameweek}
            </span>
          )}
        </div>

        {/* Player identity */}
        <div style={{ display: "flex", flexDirection: "column", alignItems: "center", marginTop: 44 }}>
          {kitDataUri ? (
            <img src={kitDataUri} width={220} height={220} style={{ objectFit: "contain" }} />
          ) : (
            <div
              style={{
                width: 180,
                height: 180,
                borderRadius: 999,
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
                backgroundColor: getTeamColors(data.teamName).primary,
                color: getTeamColors(data.teamName).secondary,
                fontSize: 56,
                fontWeight: 800,
              }}
            >
              {getTeamColors(data.teamName).abbr}
            </div>
          )}
          <span style={{ marginTop: 24, fontSize: 52, fontWeight: 800, color: "#ffffff", textAlign: "center" }}>{data.fullName}</span>
          <span style={{ marginTop: 8, fontSize: 26, color: NAVY[300] }}>
            {data.position} · {data.teamName} · £{data.price.toFixed(1)}m
          </span>
        </div>

        {/* Fixture */}
        {data.primaryFixture && (
          <div
            style={{
              display: "flex",
              alignItems: "center",
              gap: 16,
              marginTop: 40,
              backgroundColor: NAVY[900],
              border: `1px solid ${NAVY[700]}`,
              borderRadius: 16,
              padding: "18px 24px",
            }}
          >
            {opponentColors && (
              <div
                style={{
                  width: 48,
                  height: 48,
                  borderRadius: 999,
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "center",
                  backgroundColor: opponentColors.primary,
                  color: opponentColors.secondary,
                  fontSize: 18,
                  fontWeight: 800,
                }}
              >
                {opponentColors.abbr}
              </div>
            )}
            <div style={{ display: "flex", flexDirection: "column" }}>
              <span style={{ fontSize: 26, fontWeight: 700, color: "#ffffff" }}>
                {data.primaryFixture.isHome ? "vs " : "at "}
                {data.primaryFixture.opponentTeamName ?? "Unknown opponent"}
              </span>
              <span style={{ fontSize: 20, color: NAVY[500] }}>
                {formatKickoff(data.primaryFixture.kickoffAt)} · {competitionLabel(data.primaryFixture.competition)}
              </span>
            </div>
          </div>
        )}

        {/* Projected points */}
        <div
          style={{
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
            marginTop: 28,
            backgroundColor: NAVY[900],
            borderRadius: 16,
            padding: "24px 32px",
          }}
        >
          <div style={{ display: "flex", flexDirection: "column" }}>
            <span style={{ fontSize: 20, fontWeight: 600, letterSpacing: 1, color: NAVY[500], textTransform: "uppercase" }}>
              Projected Points
            </span>
            <span style={{ fontSize: 96, fontWeight: 800, color: SKY[400], lineHeight: 1 }}>{data.finalScore.toFixed(1)}</span>
          </div>
          <span
            style={{
              fontSize: 22,
              fontWeight: 700,
              color: confidence.fg,
              backgroundColor: confidence.bg,
              borderRadius: 999,
              padding: "10px 22px",
            }}
          >
            {data.dataConfidence.label} confidence
          </span>
        </div>

        {/* Stat tiles */}
        {(realStatsRow?.last_gw_points != null || statTiles.length > 0) && (
          <div style={{ display: "flex", gap: 16, marginTop: 24 }}>
            {realStatsRow?.last_gw_points != null && (
              <div
                style={{
                  display: "flex",
                  flexDirection: "column",
                  alignItems: "center",
                  flex: 1,
                  backgroundColor: NAVY[900],
                  borderRadius: 14,
                  padding: "18px 10px",
                }}
              >
                <span style={{ fontSize: 34, fontWeight: 800, color: "#ffffff" }}>{Number(realStatsRow.last_gw_points).toFixed(1)}</span>
                <span style={{ fontSize: 16, color: NAVY[500], textTransform: "uppercase", marginTop: 4 }}>GW{realStatsRow.last_gw} pts</span>
              </div>
            )}
            {statTiles.map(([label, value]) => (
              <div
                key={label}
                style={{
                  display: "flex",
                  flexDirection: "column",
                  alignItems: "center",
                  flex: 1,
                  backgroundColor: NAVY[900],
                  borderRadius: 14,
                  padding: "18px 10px",
                }}
              >
                <span style={{ fontSize: 34, fontWeight: 800, color: "#ffffff" }}>{value}</span>
                <span style={{ fontSize: 16, color: NAVY[500], textTransform: "uppercase", marginTop: 4 }}>{label}</span>
              </div>
            ))}
          </div>
        )}

        {/* Footer */}
        <div style={{ display: "flex", flex: 1 }} />
        <div style={{ display: "flex", justifyContent: "center" }}>
          <span style={{ fontSize: 18, color: NAVY[500], letterSpacing: 2, textTransform: "uppercase" }}>Hail Mary Projections</span>
        </div>
      </div>
    ),
    { width: SIZE, height: SIZE }
  );
}
