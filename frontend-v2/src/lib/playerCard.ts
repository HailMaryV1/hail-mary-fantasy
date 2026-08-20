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
  lastGw: number | null;
  lastGwPoints: number | string | null;
  statTiles: [string, number | string][];
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
    lastGw,
    lastGwPoints,
    statTiles,
  } = input;

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
          padding: `${s(40)}px ${s(46)}px`,
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

      // player identity
      h(
        "div",
        { style: { display: "flex", flexDirection: "column", alignItems: "center", marginTop: s(20) } },
        kitDataUri
          ? h("img", { src: kitDataUri, width: s(208), height: s(224), style: { objectFit: "contain" } })
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
        heading({ marginTop: s(24), fontSize: s(66), color: "#ffffff", textAlign: "center", letterSpacing: s(-1) }, fullName.toUpperCase()),
        label(
          { marginTop: s(10), fontSize: s(23), color: NAVY[300], letterSpacing: s(2) },
          `${position} · ${teamName} · £${price.toFixed(1)}m`
        )
      ),

      // fixture
      primaryFixture
        ? panel(
            { alignItems: "center", gap: s(20), marginTop: s(32), padding: `${s(20)}px ${s(26)}px` },
            [
              opponentColors
                ? h(
                    "div",
                    {
                      style: {
                        display: "flex",
                        width: s(52),
                        height: s(52),
                        borderRadius: 999,
                        alignItems: "center",
                        justifyContent: "center",
                        backgroundColor: opponentColors.primary,
                        color: opponentColors.secondary,
                      },
                    },
                    heading({ fontSize: s(18), color: opponentColors.secondary }, opponentColors.abbr)
                  )
                : null,
              h(
                "div",
                { style: { display: "flex", flexDirection: "column" } },
                heading(
                  { fontSize: s(27), color: "#ffffff" },
                  `${primaryFixture.isHome ? "vs " : "at "}${primaryFixture.opponentTeamName ?? "Unknown opponent"}`
                ),
                label(
                  { fontSize: s(19), color: NAVY[500], marginTop: s(2) },
                  `${formatKickoff(primaryFixture.kickoffAt)} · ${competitionLabel(primaryFixture.competition)}`
                )
              ),
            ]
          )
        : null,

      // projected points
      panel(
        { alignItems: "center", justifyContent: "space-between", marginTop: s(24), padding: `${s(26)}px ${s(34)}px` },
        [
          h(
            "div",
            { style: { display: "flex", flexDirection: "column" } },
            label({ fontSize: s(20), color: NAVY[500], letterSpacing: s(2) }, "Projected Points"),
            heading({ fontSize: s(104), color: SKY[400], lineHeight: 1 }, finalScore.toFixed(1))
          ),
          label(
            {
              fontSize: s(22),
              color: confidence.fg,
              backgroundColor: confidence.bg,
              borderRadius: 999,
              padding: `${s(11)}px ${s(22)}px`,
              display: "flex",
            },
            `${confidenceLabel} confidence`
          ),
        ]
      ),

      // stat tiles
      lastGwPoints != null || statTiles.length > 0
        ? h(
            "div",
            { style: { display: "flex", gap: s(16), marginTop: s(22) } },
            ...(lastGwPoints != null
              ? [
                  panel({ flexDirection: "column", alignItems: "center", flex: 1, padding: `${s(18)}px ${s(10)}px` }, [
                    heading({ fontSize: s(34), color: "#ffffff" }, Number(lastGwPoints).toFixed(1)),
                    label({ fontSize: s(16), color: NAVY[500], marginTop: s(4) }, `GW${lastGw} pts`),
                  ]),
                ]
              : []),
            ...statTiles.map(([statLabel, value]) =>
              panel({ flexDirection: "column", alignItems: "center", flex: 1, padding: `${s(18)}px ${s(10)}px` }, [
                heading({ fontSize: s(34), color: "#ffffff" }, String(value)),
                label({ fontSize: s(16), color: NAVY[500], marginTop: s(4) }, statLabel),
              ])
            )
          )
        : null,

      h("div", { style: { display: "flex", flex: 1 } }),

      // footer
      h(
        "div",
        { style: { display: "flex", justifyContent: "center" } },
        label({ fontSize: s(18), color: NAVY[500], letterSpacing: s(4) }, "Hail Mary Projections")
      )
    )
  );
}
