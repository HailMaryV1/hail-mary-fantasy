import { createElement as h, type ReactNode } from "react";
import { getTeamColors } from "./teamColors";
import { fixtureDifficultyTier } from "./fixtureDifficultyColor";

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
 * flourishes, a blue rim-light on the frame's left edge), with FOUR pre-
 * drawn empty panel slots baked into the image itself - fixture, a taller
 * projected-points bar, a row of 3 tiles, then a 4th bar the user added
 * specifically to hold the projection-trend chart (first version of this
 * background only had 3 slots and the trend chart was dropped for lack of
 * room - restored once the 4th slot arrived). Every content panel below is
 * positioned to land exactly inside one of those pre-drawn slots
 * (coordinates measured directly off the real PNG via a pixel scan - see
 * the FIXTURE_PANEL_TOP etc. constants, re-measured from scratch after the
 * user's edit since the whole layout shifted to make room for the 4th
 * slot), so panels render transparent: the image's own fill/border is the
 * panel, this file only places content on top of it.
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
// frame's inner clear edge sits at x=218 y=60 (top-left) - scaled to this
// file's 1200-design-space (*1200/1254) and rounded. Only used to position
// the open "hero" area (header + kit + name) - the panels below use their
// own directly-measured PANEL_LEFT/PANEL_WIDTH instead.
const FRAME_X = 209;
const FRAME_Y = 57;
const CONTENT_PAD_X = 26;
const CONTENT_PAD_Y = 40;
// Left edge + width every content panel shares - matches the pre-drawn
// panel rectangles' measured left/right edges (x=245..1001 in image-space,
// scaled) so panel text lands inside the image's own fill/border instead
// of a second CSS-drawn box misaligned a few pixels off it.
const PANEL_LEFT = 235;
const PANEL_WIDTH = 723;
// Top offset (design-space) + height of each of the 4 pre-drawn panel
// slots, measured the same way (brightness-transition scan down the
// image's vertical center / through each panel, cross-checked by
// overlaying the computed boxes back onto the real PNG).
const FIXTURE_PANEL_TOP = 490;
const FIXTURE_PANEL_H = 115;
const POINTS_PANEL_TOP = 622;
const POINTS_PANEL_H = 197;
const TILES_PANEL_TOP = 835;
const TILES_PANEL_H = 119;
const TREND_PANEL_TOP = 969;
const TREND_PANEL_H = 146;
const FOOTER_TOP = 1160;

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

// Hex-value mirror of hailMaryRating.ts's ratingTier() tone classes -
// satori (this file's renderer) needs inline colors, not Tailwind
// classNames, so the same 5-band scheme is duplicated here as hex pairs
// rather than trying to resolve a Tailwind class string at render time.
const RATING_TIER_COLORS: { min: number; label: string; bg: string; fg: string }[] = [
  { min: 10, label: "Nailed On", bg: "#0f3d2e", fg: "#34d399" },
  { min: 8, label: "Strong Pick", bg: "#0f3d3a", fg: "#2dd4bf" },
  { min: 6, label: "Solid Option", bg: "#0c2f4a", fg: "#38bdf8" },
  { min: 4, label: "Fringe Pick", bg: "#4a2c06", fg: "#fbbf24" },
  { min: 1, label: "Longshot", bg: "#451414", fg: "#f87171" },
];
function ratingTierColors(rating: number | null): { label: string; bg: string; fg: string } | null {
  if (rating == null) return null;
  return RATING_TIER_COLORS.find((t) => rating >= t.min) ?? null;
}

export function formatKickoff(iso: string): string {
  return new Date(iso).toLocaleString("en-GB", { weekday: "short", day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" });
}

export type PlayerCardFixture = {
  opponentTeamName: string | null;
  kickoffAt: string;
  competition: string | null;
  isHome: boolean;
};

export type PlayerCardTrendPoint = { gameweek: number; score: number; rating: number | null };

// Target Score breakdown (2026-08-23 user request - "All this should be
// downloadable on a card. So should show all 3 [4] ratings, fixtures
// within that chosen period, fixture quality in that chosen period") -
// only present when the download was triggered from /ratings with a
// horizon selected. When present, this REPLACES the trend-chart panel
// below (the 4th slot) rather than adding a 5th - card-bg.png's 4 panel
// slots are pre-drawn art with no spare room, and the trend chart's own
// "past few gameweeks" story overlaps with (and matters less than) a
// forward-looking horizon breakdown when that's specifically what was
// asked for.
export type PlayerCardTargetScore = {
  horizon: number;
  startGameweek: number;
  endGameweek: number;
  targetScore: number;
  formRating: number | null;
  fixtureDifficultyRating: number | null;
  fixtureQuantityRating: number | null;
  liveOddsRating: number | null;
  windowFixtures: { opponentTeamName: string | null; isHome: boolean; difficultyRaw: number | null }[];
};

export type PlayerCardInput = {
  fullName: string;
  teamName: string;
  position: string;
  price: number;
  // False for EFL Fantasy (see lib/gameConfig.ts's hasBudget) - it has no
  // real price/budget system at all, so `price` here is always a
  // meaningless 0 for that game. Hides the "· £X.Xm" segment rather than
  // showing a fake £0.0m (2026-08-21 user report).
  hasBudget: boolean;
  gameweek: number | null;
  finalScore: number;
  // The 1-10 Hail Mary Rating (migration 0135) - what's actually shown on
  // the card; finalScore above is a backend-only value now, kept only to
  // compute the underlying panels (e.g. Bookies-Say-style breakdown, if
  // ever added here) - never rendered directly.
  rating: number | null;
  confidenceLabel: "High" | "Medium" | "Low";
  logoDataUri: string | null;
  kitDataUri: string | null;
  // The real background art (public/card-bg.png) as a data URI - null
  // falls back to a flat INK fill rather than failing the whole render.
  backgroundDataUri: string | null;
  primaryFixture: PlayerCardFixture | null;
  competitionLabel: (competition: string | null) => string;
  // Upcoming-gameweek projections (from the `projections` table) - drawn
  // into the 4th pre-drawn panel slot the user added specifically for this.
  trend: PlayerCardTrendPoint[];
  teamWinProbability: number | null;
  cleanSheetProbability: number | null;
  goalProbability: number | null;
  assistProbability: number | null;
  targetScore?: PlayerCardTargetScore | null;
};

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
    hasBudget,
    gameweek,
    finalScore,
    rating,
    confidenceLabel,
    logoDataUri,
    kitDataUri,
    backgroundDataUri,
    primaryFixture,
    competitionLabel,
    trend,
    teamWinProbability,
    cleanSheetProbability,
    goalProbability,
    assistProbability,
    targetScore,
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

  // A content panel positioned exactly over one of card-bg.png's 4 pre-
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

  // Projection trend chart - lands in the 4th pre-drawn slot. Same shape
  // as before this design's background swap: a small area+line chart of
  // upcoming gameweek scores, with real Oswald-rendered value/gameweek
  // labels absolutely positioned over a pure-vector SVG line.
  const CHART_PAD_X = 24;
  const CHART_H = 62;
  const chartInnerWidth = PANEL_WIDTH - 2 * CHART_PAD_X;
  const trendChart =
    trend.length >= 2
      ? (() => {
          // Ratings only (score stays backend-only) - a missing rating
          // (not yet recomputed for that gameweek) plots as 0, same
          // "off the bottom of the scale" convention PlayerInfoPanel's
          // own trend chart uses.
          const ratings = trend.map((t) => t.rating ?? 0);
          const minScore = Math.min(...ratings);
          const maxScore = Math.max(...ratings);
          const range = maxScore - minScore || 1;
          const points = trend.map((t, i) => ({
            x: (i / (trend.length - 1)) * chartInnerWidth,
            y: CHART_H - (((t.rating ?? 0) - minScore) / range) * (CHART_H - 12) - 6,
          }));
          // Deterministic absolute positions, not a flex spacer - a flex:1
          // spacer inside an absolutely-positioned column turned out
          // unreliable in satori's layout engine (the gameweek label
          // didn't consistently pin to the container's bottom edge, so a
          // steeply descending line segment could visually cross right
          // through it). The value label sits just above its own point;
          // the gameweek label sits on a single fixed row well below the
          // entire chart image, so neither can ever intersect the line.
          const VALUE_LABEL_H = 22;
          const GW_LABEL_TOP = CHART_H + 10;
          return slot(TREND_PANEL_TOP, TREND_PANEL_H, { flexDirection: "column", padding: `${s(14)}px ${s(24)}px` }, [
            label({ fontSize: s(14), color: NAVY[500], letterSpacing: s(2) }, "Rating Trend"),
            h(
              "div",
              {
                style: {
                  display: "flex",
                  position: "relative",
                  width: s(chartInnerWidth),
                  height: s(GW_LABEL_TOP + 18),
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
                  heading({ fontSize: s(16), color: "#ffffff", textAlign: "center" }, t.rating != null ? String(t.rating) : "—")
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
                  label({ fontSize: s(11), color: NAVY[500], textAlign: "center" }, `GW${t.gameweek}`)
                ),
              ])
            ),
          ]);
        })()
      : null;

  // Target Score breakdown - lands in the SAME 4th slot the trend chart
  // uses (see PlayerCardTargetScore's docstring for why it replaces
  // rather than adds to it). Compact by necessity (146 design-units
  // tall): header + composite, a row of the 4 sub-ratings (blank, never
  // "0", wherever that signal genuinely doesn't exist), then up to 3 of
  // the window's real fixtures.
  const SUB_RATING_LABELS: [string, number | null][] = targetScore
    ? [
        ["Form", targetScore.formRating],
        ["Fix Diff", targetScore.fixtureDifficultyRating],
        ["Fixtures", targetScore.fixtureQuantityRating],
        ["Live Odds", targetScore.liveOddsRating],
      ]
    : [];
  const targetScorePanel = targetScore
    ? slot(TREND_PANEL_TOP, TREND_PANEL_H, { flexDirection: "column", padding: `${s(14)}px ${s(24)}px`, gap: s(10) }, [
        h(
          "div",
          { style: { display: "flex", alignItems: "baseline", justifyContent: "space-between" } },
          label(
            { fontSize: s(14), color: NAVY[500], letterSpacing: s(1) },
            targetScore.horizon === 1 ? "TARGET SCORE · THIS GAMEWEEK" : `TARGET SCORE · NEXT ${targetScore.horizon} GAMEWEEKS`
          ),
          h(
            "div",
            { style: { display: "flex", alignItems: "baseline", gap: s(6) } },
            heading({ fontSize: s(34), color: SKY[400], lineHeight: 1 }, String(Math.round(targetScore.targetScore))),
            label({ fontSize: s(15), color: NAVY[500], lineHeight: 1 }, "/10")
          )
        ),
        h(
          "div",
          { style: { display: "flex", gap: s(10) } },
          ...SUB_RATING_LABELS.map(([lbl, val], i) =>
            h(
              "div",
              {
                key: i,
                style: {
                  display: "flex",
                  flexDirection: "column",
                  alignItems: "center",
                  flex: 1,
                  backgroundColor: NAVY[900],
                  borderRadius: s(10),
                  padding: `${s(8)}px 0`,
                },
              },
              heading({ fontSize: s(20), color: val != null ? "#ffffff" : NAVY[500] }, val != null ? String(val) : "—"),
              label({ fontSize: s(10), color: NAVY[500], marginTop: s(2) }, lbl)
            )
          )
        ),
        targetScore.windowFixtures.length > 0
          ? h(
              "div",
              { style: { display: "flex", flexWrap: "wrap", gap: s(6) } },
              ...targetScore.windowFixtures.slice(0, 3).map((f, i) => {
                const tier = fixtureDifficultyTier(f.difficultyRaw);
                return h(
                  "span",
                  {
                    key: i,
                    style: {
                      display: "flex",
                      fontFamily: "Oswald",
                      fontWeight: 500,
                      fontSize: s(13),
                      borderRadius: s(6),
                      padding: `${s(3)}px ${s(8)}px`,
                      backgroundColor: tier ? tier.bg : NAVY[900],
                      color: tier ? tier.fg : NAVY[500],
                    },
                  },
                  `${f.isHome ? "vs" : "at"} ${f.opponentTeamName ?? "TBC"}`
                );
              })
            )
          : null,
      ])
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
      //
      // Real user report 2026-08-21: with the new 4th trend-chart slot
      // pushing FIXTURE_PANEL_TOP up to 490 (design-space), this block's
      // natural flow height (header + kit + name + position line) landed
      // at ~516 - past the fixture panel's own top, so the position/team/
      // price label rendered underneath (overlapping) "vs Opponent". Sizes
      // trimmed here across three passes (kit block marginTop 20->0, kit
      // 208x224->158x170, name marginTop 20->4, label marginTop 8->0 - the
      // first two passes weren't enough per real rendered cards) bring the
      // whole identity block up with real clearance before the fixture panel.
      h(
        "div",
        { style: { display: "flex", flexDirection: "column", alignItems: "center", marginTop: s(0) } },
        kitDataUri
          ? h("img", {
              src: kitDataUri,
              width: s(158),
              height: s(170),
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
        heading({ marginTop: s(4), fontSize: s(62), color: "#ffffff", textAlign: "center", letterSpacing: s(-1) }, fullName.toUpperCase()),
        label(
          { marginTop: s(0), fontSize: s(22), color: NAVY[300], letterSpacing: s(2) },
          hasBudget ? `${position} · ${teamName} · £${price.toFixed(1)}m` : `${position} · ${teamName}`
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

    // Hail Mary Rating - second, taller pre-drawn panel slot. finalScore
    // (raw projected points) still drives this number's computation but
    // is never itself rendered - see hailMaryRating.ts's own docstring.
    slot(POINTS_PANEL_TOP, POINTS_PANEL_H, { alignItems: "center", justifyContent: "space-between", padding: `0 ${s(30)}px` }, [
      h(
        "div",
        { style: { display: "flex", flexDirection: "column" } },
        label({ fontSize: s(19), color: NAVY[500], letterSpacing: s(2) }, "Hail Mary Rating"),
        h(
          "div",
          { style: { display: "flex", alignItems: "baseline", gap: s(8) } },
          heading({ fontSize: s(92), color: SKY[400], lineHeight: 1 }, rating != null ? String(rating) : "—"),
          label({ fontSize: s(28), color: NAVY[500], lineHeight: 1 }, "/10")
        )
      ),
      h(
        "div",
        { style: { display: "flex", flexDirection: "column", alignItems: "flex-end", gap: s(10) } },
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
        (() => {
          const tier = ratingTierColors(rating);
          return tier
            ? label(
                {
                  fontSize: s(21),
                  color: tier.fg,
                  backgroundColor: tier.bg,
                  borderRadius: 999,
                  padding: `${s(10)}px ${s(20)}px`,
                  display: "flex",
                },
                tier.label
              )
            : null;
        })(),
      ),
    ]),

    // model insight tiles - team win / clean sheet / goal / assist %,
    // third pre-drawn slot's row of 3 equal boxes
    slot(TILES_PANEL_TOP, TILES_PANEL_H, { gap: s(15) }, [
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

    targetScore ? targetScorePanel : trendChart,

    // footer - below the chrome frame's own bottom edge, in the plain
    // background margin (same placement idea as the previous design)
    h(
      "div",
      { style: { display: "flex", position: "absolute", top: s(FOOTER_TOP), left: s(FRAME_X), right: s(FRAME_X), justifyContent: "center" } },
      label({ fontSize: s(17), color: NAVY[500], letterSpacing: s(4) }, "Hail Mary Projections")
    )
  );
}
