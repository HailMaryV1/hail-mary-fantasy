import { createElement as h, type ReactNode } from "react";
import { getTeamColors } from "./teamColors";

/**
 * Pure element-builder for the shareable "Hail Mary Projection Card" PNG
 * (api/player-card/route.tsx). Written with React.createElement (no JSX)
 * so this exact same code path can be imported and rendered from a plain
 * Node script for visual verification against REAL data, not a hand-typed
 * copy - a hand-typed copy is what put the wrong kit/team-name pairing in
 * front of the user the first time round.
 *
 * Visual direction (2026-08-20 user-supplied reference image): a dark
 * "tactics board" backdrop (dashed pass lines, marker dots, soft light
 * beams) behind a glassy phone-style bezel frame, condensed Oswald
 * headline type, flat panels - no per-club gradient theming, matching the
 * reference's uniform navy palette rather than tinting per team.
 *
 * All layout numbers are authored in a 1200x1200 "design space" and run
 * through s() to a SCALE-d final canvas - confirmed via a standalone
 * render test that satori/resvg (next/og's renderer) does NOT honour CSS
 * `transform: scale()` here (a scaled child rendered unscaled, clipped to
 * its unscaled box), so getting a crisper "HD" render means requesting a
 * bigger canvas and scaling every pixel value that feeds it, not a single
 * transform. The tactics-board SVG is the one exception - its internal
 * path/circle coordinates stay in 1200-space and its own width/height
 * attributes are set to the scaled canvas size, letting the SVG's native
 * viewBox scaling handle that piece without touching its numbers.
 */

const SCALE = 1.5;
export const PLAYER_CARD_SIZE = Math.round(1200 * SCALE);
const s = (n: number) => Math.round(n * SCALE);

// Card inset within the square canvas - asymmetric on purpose (2026-08-20
// user request: "make the card less square, but still on a square bg").
// Wider left/right margin than top/bottom gives the card itself a
// portrait phone-like ratio while the canvas stays square, and opens up
// real background margin on both sides for the tactics-board detail to
// live in without crowding the panels.
const FRAME_X = 130;
const FRAME_Y = 45;
const CONTENT_PAD_X = 44;
const CONTENT_PAD_Y = 36;
// The card's own inner content width in 1200-design-space - every panel
// below implicitly fills this (flex column with no explicit width), but
// the trend chart's embedded SVG needs an explicit pixel width up front
// to lay out its points, so this is computed once and reused.
const CONTENT_WIDTH = 1200 - FRAME_X * 2 - CONTENT_PAD_X * 2;

const NAVY = { 950: "#050b16", 900: "#0b1524", 850: "#0f1c30", 800: "#14203a", 700: "#1e2e45", 500: "#46617f", 300: "#a8b8cc" };
const SKY = { 400: "#38bdf8" };
const INK = "#03050b";

const CONFIDENCE_COLORS: Record<string, { bg: string; fg: string }> = {
  High: { bg: "#0f3d2e", fg: "#34d399" },
  Medium: { bg: "#4a2c06", fg: "#fbbf24" },
  Low: { bg: "#451414", fg: "#f87171" },
};

export function formatKickoff(iso: string): string {
  return new Date(iso).toLocaleString("en-GB", { weekday: "short", day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" });
}

export type PlayerCardFixture = {
  opponentTeamName: string | null;
  kickoffAt: string;
  competition: string | null;
  isHome: boolean;
};

export type PlayerCardTrendPoint = { gameweek: number; score: number };

export type PlayerCardInput = {
  fullName: string;
  teamName: string;
  position: string;
  price: number;
  gameweek: number | null;
  finalScore: number;
  confidenceLabel: "High" | "Medium" | "Low";
  logoDataUri: string | null;
  kitDataUri: string | null;
  primaryFixture: PlayerCardFixture | null;
  competitionLabel: (competition: string | null) => string;
  // 2026-08-20 user request ("we want these cards to be projecting into
  // the future... replace last season's stats with the projection
  // trend"): the real-season stat tiles that used to live here are gone -
  // upcoming-gameweek projections (from the `projections` table, not
  // player_projection_summary's single "current" row) instead.
  trend: PlayerCardTrendPoint[];
  // Same request's "if you can fit on the second game warning/info too" -
  // the additional-fixtures note PlayerInfoPanel already shows (Carabao
  // Cup etc.), condensed to one line - null when the player has none.
  additionalFixturesNote: string | null;
  // 2026-08-20 user request - real model output, not real-world results:
  // team win probability (team_fixture_difficulty.team_win_prob) is
  // fixture/team-level so it applies to every position; clean sheet is
  // shown for GK/DEF, goal/assist for MID/FWD - all straight off the
  // engine's own Bookmaker Intelligence blend (moduleDetail), same figures
  // Engine Validation already shows, just surfaced here too.
  teamWinProbability: number | null;
  cleanSheetProbability: number | null;
  goalProbability: number | null;
  assistProbability: number | null;
};

// Tactics-board backdrop: a passing-network of dashed arcs, connector
// lines, an arrowed pass, and marker dots/crosses in the left margin; a
// soft radial "spotlight" behind the kit; an ascending bar-chart plus
// radar-ring flourish and fine dot-grid texture in the right margin; and
// layered diagonal light beams - drawn once in SVG rather than as a
// raster asset so it's crisp at any card size. 2026-08-20 user request
// ("more detail in the background... make it slick and fancy") plus the
// card's own inset moving from a near-full-bleed square to FRAME_X/
// FRAME_Y (see buildPlayerCardElement) opened up genuine, unobstructed
// left/right margins - wide enough that the bar chart now lives entirely
// outside the card's own right edge, so it can't collide with a panel or
// the frame's rounded corner the way an earlier full-bleed version did.
// Coordinates stay in 1200-space; the caller sets this SVG's own
// width/height to the final scaled canvas size so its native viewBox
// scaling does the upscaling losslessly.
function tacticsBoardSvg() {
  const line = (d: string, extra = "") =>
    `<path d="${d}" stroke="rgba(125,211,252,0.22)" stroke-width="2.5" stroke-linecap="round" fill="none" ${extra}/>`;
  const dot = (cx: number, cy: number, r = 8) =>
    `<circle cx="${cx}" cy="${cy}" r="${r}" stroke="rgba(148,197,255,0.28)" stroke-width="2" fill="none"/>`;
  const cross = (cx: number, cy: number, sz = 9) =>
    `<path d="M ${cx - sz} ${cy - sz} L ${cx + sz} ${cy + sz} M ${cx - sz} ${cy + sz} L ${cx + sz} ${cy - sz}" stroke="rgba(148,197,255,0.24)" stroke-width="2.5" stroke-linecap="round"/>`;
  const connector = (x1: number, y1: number, x2: number, y2: number) =>
    `<line x1="${x1}" y1="${y1}" x2="${x2}" y2="${y2}" stroke="rgba(148,197,255,0.13)" stroke-width="1.5" stroke-linecap="round"/>`;
  const bar = (x: number, h: number) => `<rect x="${x}" y="${1160 - h}" width="20" height="${h}" rx="4" fill="rgba(56,189,248,0.14)"/>`;

  let dotGrid = "";
  for (let gx = 1095; gx <= 1180; gx += 21) {
    for (let gy = 120; gy <= 340; gy += 21) {
      dotGrid += `<circle cx="${gx}" cy="${gy}" r="1.6" fill="rgba(148,197,255,0.16)"/>`;
    }
  }

  const svg = `<svg width="1200" height="1200" viewBox="0 0 1200 1200" xmlns="http://www.w3.org/2000/svg">
    <defs>
      <linearGradient id="beamA" x1="0%" y1="0%" x2="100%" y2="100%">
        <stop offset="0%" stop-color="#ffffff" stop-opacity="0"/>
        <stop offset="50%" stop-color="#ffffff" stop-opacity="0.05"/>
        <stop offset="100%" stop-color="#ffffff" stop-opacity="0"/>
      </linearGradient>
      <linearGradient id="beamB" x1="100%" y1="0%" x2="0%" y2="100%">
        <stop offset="0%" stop-color="#7dd3fc" stop-opacity="0"/>
        <stop offset="50%" stop-color="#7dd3fc" stop-opacity="0.06"/>
        <stop offset="100%" stop-color="#7dd3fc" stop-opacity="0"/>
      </linearGradient>
      <linearGradient id="beamC" x1="50%" y1="0%" x2="50%" y2="100%">
        <stop offset="0%" stop-color="#38bdf8" stop-opacity="0"/>
        <stop offset="50%" stop-color="#38bdf8" stop-opacity="0.045"/>
        <stop offset="100%" stop-color="#38bdf8" stop-opacity="0"/>
      </linearGradient>
      <radialGradient id="spotlight" cx="50%" cy="50%" r="50%">
        <stop offset="0%" stop-color="#7dd3fc" stop-opacity="0.16"/>
        <stop offset="55%" stop-color="#7dd3fc" stop-opacity="0.05"/>
        <stop offset="100%" stop-color="#7dd3fc" stop-opacity="0"/>
      </radialGradient>
      <radialGradient id="radarGlow" cx="50%" cy="50%" r="50%">
        <stop offset="0%" stop-color="#38bdf8" stop-opacity="0.10"/>
        <stop offset="100%" stop-color="#38bdf8" stop-opacity="0"/>
      </radialGradient>
      <marker id="arrowhead" markerWidth="8" markerHeight="8" refX="4" refY="4" orient="auto">
        <path d="M0,0 L8,4 L0,8 Z" fill="rgba(148,197,255,0.4)"/>
      </marker>
    </defs>

    <circle cx="470" cy="270" r="300" fill="url(#spotlight)"/>

    <line x1="-140" y1="960" x2="600" y2="-140" stroke="url(#beamA)" stroke-width="170" stroke-linecap="round"/>
    <line x1="680" y1="1320" x2="1320" y2="600" stroke="url(#beamB)" stroke-width="150" stroke-linecap="round"/>
    <line x1="60" y1="1300" x2="60" y2="-100" stroke="url(#beamC)" stroke-width="220" stroke-linecap="round"/>

    ${line("M 44 220 Q 200 60 400 200", 'stroke-dasharray="1 14"')}
    ${line("M 28 430 Q 140 360 232 448", 'stroke-dasharray="1 14"')}
    ${line("M 82 610 L 82 860", 'stroke-dasharray="1 12"')}
    ${line("M 40 900 Q 150 940 250 880", 'marker-end="url(#arrowhead)"')}
    ${connector(44, 220, 28, 430)}
    ${connector(400, 200, 232, 448)}
    ${connector(232, 448, 82, 610)}
    ${connector(28, 430, 40, 900)}
    ${dot(44, 220)}
    ${dot(400, 200, 6)}
    ${dot(28, 430, 6)}
    ${dot(232, 448)}
    ${dot(82, 860, 6)}
    ${cross(160, 300)}
    ${cross(130, 540)}
    ${cross(60, 740)}
    ${cross(200, 940)}

    ${dotGrid}
    ${bar(1096, 60)}
    ${bar(1122, 100)}
    ${bar(1148, 82)}
    ${bar(1174, 140)}

    <g fill="none" stroke="rgba(125,211,252,0.16)" stroke-width="2">
      <circle cx="1160" cy="1200" r="80"/>
      <circle cx="1160" cy="1200" r="135"/>
      <circle cx="1160" cy="1200" r="190"/>
    </g>
    <circle cx="1160" cy="1200" r="190" fill="url(#radarGlow)"/>
    <line x1="1160" y1="1010" x2="1160" y2="1200" stroke="rgba(125,211,252,0.11)" stroke-width="1.5" stroke-dasharray="1 10"/>
    <line x1="970" y1="1200" x2="1160" y2="1200" stroke="rgba(125,211,252,0.11)" stroke-width="1.5" stroke-dasharray="1 10"/>
  </svg>`;
  return `data:image/svg+xml;base64,${Buffer.from(svg).toString("base64")}`;
}

// Trend line + area fill only, drawn as SVG (pure vector shapes, no text -
// resvg's handling of text baked into an embedded SVG-as-image is
// unverified, unlike satori's own text layer which every other word on
// this card already goes through) - the numeric/gameweek labels are real
// sibling <span> elements absolutely-positioned on top of this image in
// buildPlayerCardElement, using the exact same point coordinates, so they
// share the card's actual Oswald font instead of an SVG fallback font.
function trendLineSvg(points: { x: number; y: number }[], width: number, height: number) {
  const linePath = points.map((p, i) => `${i === 0 ? "M" : "L"} ${p.x} ${p.y}`).join(" ");
  const areaPath = `${linePath} L ${points[points.length - 1].x} ${height} L ${points[0].x} ${height} Z`;
  const dots = points.map((p) => `<circle cx="${p.x}" cy="${p.y}" r="5" fill="#38bdf8" stroke="#0b1524" stroke-width="2.5"/>`).join("");
  const svg = `<svg width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" xmlns="http://www.w3.org/2000/svg">
    <defs>
      <linearGradient id="trendFill" x1="0" y1="0" x2="0" y2="1">
        <stop offset="0%" stop-color="#38bdf8" stop-opacity="0.32"/>
        <stop offset="100%" stop-color="#38bdf8" stop-opacity="0"/>
      </linearGradient>
    </defs>
    <path d="${areaPath}" fill="url(#trendFill)"/>
    <path d="${linePath}" stroke="#38bdf8" stroke-width="3" fill="none" stroke-linecap="round" stroke-linejoin="round"/>
    ${dots}
  </svg>`;
  return `data:image/svg+xml;base64,${Buffer.from(svg).toString("base64")}`;
}

export function buildPlayerCardElement(input: PlayerCardInput) {
  const {
    fullName,
    teamName,
    position,
    price,
    gameweek,
    finalScore,
    confidenceLabel,
    logoDataUri,
    kitDataUri,
    primaryFixture,
    competitionLabel,
    trend,
    additionalFixturesNote,
    teamWinProbability,
    cleanSheetProbability,
    goalProbability,
    assistProbability,
  } = input;

  const isDefensivePosition = position === "GK" || position === "DEF";
  const pct = (n: number) => `${Math.round(n * 100)}%`;
  const insightTiles: [string, string][] = [
    ...(teamWinProbability != null ? ([["Team Win", pct(teamWinProbability)]] as [string, string][]) : []),
    ...(isDefensivePosition && cleanSheetProbability != null
      ? ([["Clean Sheet", pct(cleanSheetProbability)]] as [string, string][])
      : []),
    ...(!isDefensivePosition && goalProbability != null ? ([["Goal Chance", pct(goalProbability)]] as [string, string][]) : []),
    ...(!isDefensivePosition && assistProbability != null ? ([["Assist Chance", pct(assistProbability)]] as [string, string][]) : []),
  ];

  const colors = getTeamColors(teamName);
  const confidence = CONFIDENCE_COLORS[confidenceLabel] ?? CONFIDENCE_COLORS.Low;
  const opponentColors = primaryFixture?.opponentTeamName ? getTeamColors(primaryFixture.opponentTeamName) : null;

  const panel = (style: Record<string, unknown>, children: ReactNode[]) =>
    h(
      "div",
      {
        style: {
          display: "flex",
          backgroundColor: NAVY[900],
          border: `${s(1)}px solid ${NAVY[700]}`,
          borderRadius: s(20),
          boxShadow: `0 ${s(16)}px ${s(32)}px -${s(20)}px rgba(0,0,0,0.7)`,
          ...style,
        },
      },
      ...children
    );

  const heading = (style: Record<string, unknown>, text: string) =>
    h("span", { style: { fontFamily: "Oswald", fontWeight: 700, ...style } }, text);

  const label = (style: Record<string, unknown>, text: string) =>
    h("span", { style: { fontFamily: "Oswald", fontWeight: 500, textTransform: "uppercase", ...style } }, text);

  // Projection trend chart - a small area+line chart of upcoming
  // gameweek scores, with real Oswald-rendered value/gameweek labels
  // absolutely positioned over a pure-vector SVG line (see trendLineSvg).
  const CHART_PAD_X = 24;
  const CHART_H = 64;
  const chartInnerWidth = CONTENT_WIDTH - 2 * CHART_PAD_X;
  const trendChart =
    trend.length >= 2
      ? (() => {
          const scores = trend.map((t) => t.score);
          const minScore = Math.min(...scores);
          const maxScore = Math.max(...scores);
          const range = maxScore - minScore || 1;
          const points = trend.map((t, i) => ({
            x: (i / (trend.length - 1)) * chartInnerWidth,
            y: CHART_H - ((t.score - minScore) / range) * (CHART_H - 12) - 6,
          }));
          // Deterministic absolute positions, not a flex spacer - a flex:1
          // spacer inside an absolutely-positioned column turned out
          // unreliable in satori's layout engine (the gameweek label
          // didn't consistently pin to the container's bottom edge, so a
          // steeply descending line segment could visually cross right
          // through it). The value label sits just above its own point;
          // the gameweek label sits on a single fixed row well below the
          // entire chart image, so neither can ever intersect the line.
          const VALUE_LABEL_H = 24;
          const GW_LABEL_TOP = CHART_H + 12;
          return panel(
            { flexDirection: "column", marginTop: s(16), padding: `${s(14)}px ${s(CHART_PAD_X)}px` },
            [
              label({ fontSize: s(14), color: NAVY[500], letterSpacing: s(2) }, "Projection Trend"),
              h(
                "div",
                {
                  style: {
                    display: "flex",
                    position: "relative",
                    width: s(chartInnerWidth),
                    height: s(GW_LABEL_TOP + 20),
                    marginTop: s(6),
                  },
                },
                h("img", {
                  src: trendLineSvg(points, chartInnerWidth, CHART_H),
                  width: s(chartInnerWidth),
                  height: s(CHART_H),
                  style: { position: "absolute", top: 0, left: 0 },
                }),
                ...trend.flatMap((t, i) => [
                  h(
                    "div",
                    {
                      key: `v${i}`,
                      style: {
                        display: "flex",
                        justifyContent: "center",
                        position: "absolute",
                        top: s(Math.max(0, points[i].y - VALUE_LABEL_H)),
                        left: s(points[i].x - 40),
                        width: s(80),
                      },
                    },
                    heading({ fontSize: s(17), color: "#ffffff", textAlign: "center" }, t.score.toFixed(1))
                  ),
                  h(
                    "div",
                    {
                      key: `g${i}`,
                      style: {
                        display: "flex",
                        justifyContent: "center",
                        position: "absolute",
                        top: s(GW_LABEL_TOP),
                        left: s(points[i].x - 40),
                        width: s(80),
                      },
                    },
                    label({ fontSize: s(12), color: NAVY[500], textAlign: "center" }, `GW${t.gameweek}`)
                  ),
                ])
              ),
            ]
          );
        })()
      : null;

  return h(
    "div",
    {
      style: {
        width: "100%",
        height: "100%",
        display: "flex",
        position: "relative",
        backgroundColor: INK,
        fontFamily: "sans-serif",
      },
    },
    // full-bleed tactics-board backdrop
    h("img", { src: tacticsBoardSvg(), width: PLAYER_CARD_SIZE, height: PLAYER_CARD_SIZE, style: { position: "absolute", top: 0, left: 0 } }),

    // glassy bezel frame - outline only, so the tactics-board backdrop
    // stays visible through the card interior, same as the reference
    h("div", {
      style: {
        display: "flex",
        position: "absolute",
        top: s(FRAME_Y),
        left: s(FRAME_X),
        right: s(FRAME_X),
        bottom: s(FRAME_Y),
        borderRadius: s(56),
        border: `${s(3)}px solid rgba(255,255,255,0.20)`,
        boxShadow: `inset 0 0 0 ${s(1)}px rgba(255,255,255,0.05)`,
      },
    }),
    // left-edge glass highlight
    h("div", {
      style: {
        display: "flex",
        position: "absolute",
        top: s(180),
        left: s(FRAME_X + 4),
        width: s(3),
        height: s(420),
        borderRadius: s(3),
        backgroundImage: "linear-gradient(180deg, rgba(255,255,255,0) 0%, rgba(255,255,255,0.6) 45%, rgba(255,255,255,0) 100%)",
      },
    }),

    // content sits directly on the tactics-board backdrop; only the
    // individual info panels below get a solid fill for legibility
    h(
      "div",
      {
        style: {
          display: "flex",
          flexDirection: "column",
          position: "absolute",
          top: s(FRAME_Y),
          left: s(FRAME_X),
          right: s(FRAME_X),
          bottom: s(FRAME_Y),
          padding: `${s(CONTENT_PAD_Y)}px ${s(CONTENT_PAD_X)}px`,
        },
      },

      // header
      h(
        "div",
        { style: { display: "flex", alignItems: "center", justifyContent: "space-between" } },
        h(
          "div",
          { style: { display: "flex", alignItems: "center", gap: s(14) } },
          logoDataUri ? h("img", { src: logoDataUri, width: s(46), height: s(47) }) : null,
          heading({ fontSize: s(28), color: "#ffffff", letterSpacing: s(1) }, "HAIL MARY")
        ),
        gameweek != null
          ? label(
              {
                fontSize: s(22),
                color: NAVY[300],
                backgroundColor: NAVY[900],
                border: `${s(1)}px solid ${NAVY[700]}`,
                borderRadius: 999,
                padding: `${s(9)}px ${s(22)}px`,
                display: "flex",
              },
              `GW${gameweek}`
            )
          : null
      ),

      // player identity - the kit PNGs are real but low-resolution source
      // art (2026-08-20 user report: "tidy up the kit images... small
      // outer glow that hides the jagged edges") - filter: drop-shadow()
      // (confirmed via a standalone render test to hug the PNG's actual
      // alpha silhouette, not just its rectangular bounding box, unlike a
      // plain CSS box-shadow) puts a soft club-colour halo right at the
      // jersey's real edge, drawing the eye there instead of to the
      // upscaled pixel edge itself.
      h(
        "div",
        { style: { display: "flex", flexDirection: "column", alignItems: "center", marginTop: s(18) } },
        kitDataUri
          ? h("img", {
              src: kitDataUri,
              width: s(208),
              height: s(224),
              style: { objectFit: "contain", filter: `drop-shadow(0px 0px ${s(14)}px ${colors.primary}99)` },
            })
          : h(
              "div",
              {
                style: {
                  display: "flex",
                  width: s(176),
                  height: s(176),
                  borderRadius: 999,
                  alignItems: "center",
                  justifyContent: "center",
                  backgroundColor: colors.primary,
                  color: colors.secondary,
                },
              },
              heading({ fontSize: s(52), color: colors.secondary }, colors.abbr)
            ),
        heading({ marginTop: s(20), fontSize: s(62), color: "#ffffff", textAlign: "center", letterSpacing: s(-1) }, fullName.toUpperCase()),
        label(
          { marginTop: s(8), fontSize: s(22), color: NAVY[300], letterSpacing: s(2) },
          `${position} · ${teamName} · £${price.toFixed(1)}m`
        )
      ),

      // fixture
      primaryFixture
        ? panel(
            { alignItems: "center", gap: s(20), marginTop: s(24), padding: `${s(18)}px ${s(24)}px` },
            [
              opponentColors
                ? h(
                    "div",
                    {
                      style: {
                        display: "flex",
                        width: s(48),
                        height: s(48),
                        borderRadius: 999,
                        alignItems: "center",
                        justifyContent: "center",
                        backgroundColor: opponentColors.primary,
                        color: opponentColors.secondary,
                      },
                    },
                    heading({ fontSize: s(17), color: opponentColors.secondary }, opponentColors.abbr)
                  )
                : null,
              h(
                "div",
                { style: { display: "flex", flexDirection: "column" } },
                heading(
                  { fontSize: s(25), color: "#ffffff" },
                  `${primaryFixture.isHome ? "vs " : "at "}${primaryFixture.opponentTeamName ?? "Unknown opponent"}`
                ),
                label(
                  { fontSize: s(18), color: NAVY[500], marginTop: s(2) },
                  `${formatKickoff(primaryFixture.kickoffAt)} · ${competitionLabel(primaryFixture.competition)}`
                )
              ),
            ]
          )
        : null,

      // projected points
      panel(
        { alignItems: "center", justifyContent: "space-between", marginTop: s(18), padding: `${s(22)}px ${s(30)}px` },
        [
          h(
            "div",
            { style: { display: "flex", flexDirection: "column" } },
            label({ fontSize: s(19), color: NAVY[500], letterSpacing: s(2) }, "Projected Points"),
            heading({ fontSize: s(92), color: SKY[400], lineHeight: 1 }, finalScore.toFixed(1))
          ),
          label(
            {
              fontSize: s(21),
              color: confidence.fg,
              backgroundColor: confidence.bg,
              borderRadius: 999,
              padding: `${s(10)}px ${s(20)}px`,
              display: "flex",
            },
            `${confidenceLabel} confidence`
          ),
        ]
      ),

      // additional-fixtures note (e.g. Carabao Cup) - condensed one-liner
      additionalFixturesNote
        ? h(
            "div",
            { style: { display: "flex", marginTop: s(10), padding: `${s(8)}px ${s(4)}px` } },
            label({ fontSize: s(15), color: "#fbbf24", textTransform: "none", lineHeight: 1.3 }, additionalFixturesNote)
          )
        : null,

      // model insight tiles - team win / clean sheet / goal / assist %
      insightTiles.length > 0
        ? h(
            "div",
            { style: { display: "flex", gap: s(14), marginTop: s(14) } },
            ...insightTiles.map(([tileLabel, tileValue]) =>
              panel({ flexDirection: "column", alignItems: "center", flex: 1, padding: `${s(12)}px ${s(8)}px` }, [
                heading({ fontSize: s(26), color: SKY[400] }, tileValue),
                label({ fontSize: s(13), color: NAVY[500], marginTop: s(3) }, tileLabel),
              ])
            )
          )
        : null,

      trendChart,

      h("div", { style: { display: "flex", flex: 1 } }),

      // footer
      h(
        "div",
        { style: { display: "flex", justifyContent: "center" } },
        label({ fontSize: s(17), color: NAVY[500], letterSpacing: s(4) }, "Hail Mary Projections")
      )
    )
  );
}
