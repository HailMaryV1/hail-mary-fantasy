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
 * Visual direction (2026-08-21 user-supplied background art, public/card-
 * bg.png): a chrome phone-bezel frame pre-rendered onto a dark tactics-
 * board backdrop (diagonal light streaks, dashed pass lines, bar-chart
 * flourishes, a blue rim-light on the frame's left edge), with THREE
 * pre-drawn empty panel slots baked into the image itself - one wide bar,
 * one taller wide bar below it, then a row of 3 equal tiles. Replaces the
 * previous hand-drawn SVG tactics-board + CSS bezel outline entirely - the
 * real image supplies both now. Every content panel below is positioned to
 * land exactly inside one of those pre-drawn slots (coordinates measured
 * directly off the real PNG via a pixel scan - see the FIXTURE_PANEL_TOP
 * etc. constants), so panels render transparent: the image's own fill/
 * border is the panel, this file only places text on top of it. The
 * previous design's projection-trend chart and additional-fixtures note
 * have no slot in the new 3-panel template and are dropped rather than
 * stretching the template to fit them.
 *
 * All layout numbers are authored in a 1200x1200 "design space" and run
 * through s() to a SCALE-d final canvas - confirmed via a standalone
 * render test that satori/resvg (next/og's renderer) does NOT honour CSS
 * `transform: scale()` here (a scaled child rendered unscaled, clipped to
 * its unscaled box), so getting a crisper "HD" render means requesting a
 * bigger canvas and scaling every pixel value that feeds it, not a single
 * transform. card-bg.png is square (1254x1254) and rendered at
 * PLAYER_CARD_SIZE x PLAYER_CARD_SIZE regardless of its native pixel size
 * - only its 1:1 aspect ratio matters, so the browser/renderer scaling it
 * to the final canvas is lossless in the same way the old SVG's viewBox
 * scaling was.
 */

const SCALE = 1.5;
export const PLAYER_CARD_SIZE = Math.round(1200 * SCALE);
const s = (n: number) => Math.round(n * SCALE);

// Chrome-frame inset, measured off the real card-bg.png (1254x1254): the
// frame's inner clear edge sits at x=[235,1015] y=[80,1178] in image-space
// - scaled to this file's 1200-design-space (*1200/1254) and rounded.
const FRAME_X = 227;
const FRAME_Y = 75;
const CONTENT_PAD_X = 26;
const CONTENT_PAD_Y = 40;
// Left edge + width every content panel shares - matches the pre-drawn
// panel rectangles' measured left/right edges (x=262..989 in image-space,
// scaled) so panel text lands inside the image's own fill/border instead
// of a second CSS-drawn box misaligned a few pixels off it.
const PANEL_LEFT = FRAME_X + CONTENT_PAD_X;
const PANEL_WIDTH = 1200 - PANEL_LEFT * 2;
// Top offset (design-space) + height of each of the 3 pre-drawn panel
// slots, measured the same way (brightness-transition scan down the
// image's vertical center / through each panel).
const FIXTURE_PANEL_TOP = 668;
const FIXTURE_PANEL_H = 92;
const POINTS_PANEL_TOP = 777;
const POINTS_PANEL_H = 185;
const TILES_PANEL_TOP = 973;
const TILES_PANEL_H = 103;
const FOOTER_TOP = 1150;

const NAVY = { 950: "#050b16", 900: "#0b1524", 850: "#0f1c30", 800: "#14203a", 700: "#1e2e45", 500: "#46617f", 300: "#a8b8cc" };
const SKY = { 400: "#38bdf8" };
const INK = "#03050b";

// Picks which of a club's two colors should glow behind the kit render.
// 2026-08-20 user report ("white shirts still struggling"): for a white-
// primary club (Fulham, Tottenham, Derby, Bromley, 12 in total - see
// teamColors.ts) the drop-shadow below used to always glow with `primary`,
// i.e. white behind a white shirt on the dark backdrop - that doesn't add a
// rim of contrast the way it does for a colored kit, it just smears the
// low-res PNG's already-jagged edge into visible white noise (confirmed
// against a real rendered Bromley card). Falls back to `secondary` whenever
// primary is near-white, giving a dark rim that actually hides the jaggies
// instead of amplifying them.
function isNearWhite(hex: string): boolean {
  const n = parseInt(hex.replace("#", ""), 16);
  const r = (n >> 16) & 255;
  const g = (n >> 8) & 255;
  const b = n & 255;
  return (r * 299 + g * 587 + b * 114) / 1000 > 235;
}
function kitGlowColor(colors: { primary: string; secondary: string }): string {
  return isNearWhite(colors.primary) ? colors.secondary : colors.primary;
}

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
  // The real background art (public/card-bg.png) as a data URI - null
  // falls back to a flat INK fill rather than failing the whole render.
  backgroundDataUri: string | null;
  primaryFixture: PlayerCardFixture | null;
  competitionLabel: (competition: string | null) => string;
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
    backgroundDataUri,
    primaryFixture,
    competitionLabel,
    teamWinProbability,
    cleanSheetProbability,
    goalProbability,
    assistProbability,
  } = input;

  const isDefensivePosition = position === "GK" || position === "DEF";
  const pct = (n: number) => `${Math.round(n * 100)}%`;
  // Always exactly 3 entries (padded with null) - the image bakes in 3
  // fixed tile slots, so a 2-tile case (GK/DEF with only Clean Sheet, no
  // Goal/Assist) must leave the 3rd slot visibly empty rather than
  // widening the other 2 to fill the row, or the tiles drift off the
  // pre-drawn boxes.
  const rawTiles: [string, string][] = [
    ...(teamWinProbability != null ? ([["Team Win", pct(teamWinProbability)]] as [string, string][]) : []),
    ...(isDefensivePosition && cleanSheetProbability != null
      ? ([["Clean Sheet", pct(cleanSheetProbability)]] as [string, string][])
      : []),
    ...(!isDefensivePosition && goalProbability != null ? ([["Goal Chance", pct(goalProbability)]] as [string, string][]) : []),
    ...(!isDefensivePosition && assistProbability != null ? ([["Assist Chance", pct(assistProbability)]] as [string, string][]) : []),
  ];
  const insightTiles: ([string, string] | null)[] = [0, 1, 2].map((i) => rawTiles[i] ?? null);

  const colors = getTeamColors(teamName);
  const confidence = CONFIDENCE_COLORS[confidenceLabel] ?? CONFIDENCE_COLORS.Low;
  const opponentColors = primaryFixture?.opponentTeamName ? getTeamColors(primaryFixture.opponentTeamName) : null;

  const heading = (style: Record<string, unknown>, text: string) =>
    h("span", { style: { fontFamily: "Oswald", fontWeight: 700, ...style } }, text);

  const label = (style: Record<string, unknown>, text: string) =>
    h("span", { style: { fontFamily: "Oswald", fontWeight: 500, textTransform: "uppercase", ...style } }, text);

  // A content panel positioned exactly over one of card-bg.png's 3 pre-
  // drawn slots - transparent (no CSS fill/border of its own), just lays
  // text/children on top of the image's real panel art.
  const slot = (top: number, height: number, style: Record<string, unknown>, children: ReactNode[]) =>
    h(
      "div",
      {
        style: {
          display: "flex",
          position: "absolute",
          top: s(top),
          left: s(PANEL_LEFT),
          width: s(PANEL_WIDTH),
          height: s(height),
          ...style,
        },
      },
      ...children
    );

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
    // full-bleed background art - real chrome bezel frame + tactics-board
    // backdrop, baked into the PNG itself (see file docstring)
    backgroundDataUri
      ? h("img", { src: backgroundDataUri, width: PLAYER_CARD_SIZE, height: PLAYER_CARD_SIZE, style: { position: "absolute", top: 0, left: 0 } })
      : null,

    // header + player identity sit in the image's open "hero" area above
    // the first panel slot - auto-height, not stretched to fill it, so
    // the diagonal-line/spotlight art stays visible around them
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
      // art - filter: drop-shadow() (confirmed via a standalone render
      // test to hug the PNG's actual alpha silhouette, not just its
      // rectangular bounding box, unlike a plain CSS box-shadow) puts a
      // soft club-colour halo right at the jersey's real edge, drawing the
      // eye there instead of to the upscaled pixel edge itself - and now
      // doubles as a bit of extra glow inside the background art's own
      // built-in spotlight behind this area.
      h(
        "div",
        { style: { display: "flex", flexDirection: "column", alignItems: "center", marginTop: s(48) } },
        kitDataUri
          ? h("img", {
              src: kitDataUri,
              width: s(208),
              height: s(224),
              style: { objectFit: "contain", filter: `drop-shadow(0px 0px ${s(14)}px ${kitGlowColor(colors)}99)` },
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
      )
    ),

    // fixture - lands inside card-bg.png's first pre-drawn panel slot
    primaryFixture
      ? slot(FIXTURE_PANEL_TOP, FIXTURE_PANEL_H, { alignItems: "center", gap: s(20), padding: `0 ${s(24)}px` }, [
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
        ])
      : null,

    // projected points - second, taller pre-drawn panel slot
    slot(POINTS_PANEL_TOP, POINTS_PANEL_H, { alignItems: "center", justifyContent: "space-between", padding: `0 ${s(30)}px` }, [
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
    ]),

    // model insight tiles - team win / clean sheet / goal / assist %,
    // third pre-drawn slot's row of 3 equal boxes
    slot(TILES_PANEL_TOP, TILES_PANEL_H, { gap: s(13) }, [
      ...insightTiles.map((tile, i) =>
        h(
          "div",
          {
            key: i,
            style: { display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", flex: 1 },
          },
          tile ? [heading({ fontSize: s(26), color: SKY[400] }, tile[1]), label({ fontSize: s(13), color: NAVY[500], marginTop: s(3) }, tile[0])] : null
        )
      ),
    ]),

    // footer - below the chrome frame's own bottom edge, in the plain
    // background margin (same placement idea as the previous design)
    h(
      "div",
      { style: { display: "flex", position: "absolute", top: s(FOOTER_TOP), left: s(FRAME_X), right: s(FRAME_X), justifyContent: "center" } },
      label({ fontSize: s(17), color: NAVY[500], letterSpacing: s(4) }, "Hail Mary Projections")
    )
  );
}
