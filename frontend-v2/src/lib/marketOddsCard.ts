import { createElement as h, type ReactNode } from "react";

/**
 * Pure element-builder for the shareable "Hail Mary Market Odds Card" PNG
 * (api/market-odds-card/route.tsx) - same "no JSX, standalone-renderable"
 * shape as lib/playerCard.ts, for the same reason (a hand-typed layout is
 * what put the wrong kit/team pairing on the player card the first time).
 *
 * Visual direction (2026-08-21 user-supplied background art, public/
 * market-odds-card.png): a chrome phone-bezel frame matching the player
 * card's own tactics-board backdrop, with the "HAIL MARY" wordmark, the 3
 * category boxes (icon + title + "BEST ODDS" column header), every row's
 * rank number (1-5), and a generic jersey-outline placeholder ALL baked
 * directly into the image - this file only overlays what's actually
 * dynamic per gameweek: the real club kit (replacing the generic jersey
 * outline), the real team name, and the real stat value per row, plus the
 * gameweek badge/footer text.
 *
 * All layout numbers below were measured directly off the real PNG via a
 * pixel scan (border-color transitions, row-icon bounding boxes) - not
 * guessed - the same methodology playerCard.ts's own coordinate constants
 * document. Native background is 1024x1536; SCALE follows playerCard.ts's
 * own "design space -> bigger canvas" approach for crisp satori/resvg text
 * (CSS transform:scale is NOT honoured by next/og's renderer).
 */

const SCALE = 1.5;
const NATIVE_WIDTH = 1024;
const NATIVE_HEIGHT = 1536;
export const MARKET_ODDS_CARD_WIDTH = Math.round(NATIVE_WIDTH * SCALE);
export const MARKET_ODDS_CARD_HEIGHT = Math.round(NATIVE_HEIGHT * SCALE);
const s = (n: number) => Math.round(n * SCALE);

const NAVY_500 = "#46617f";
const SKY_400 = "#38bdf8";
const WHITE = "#ffffff";
// Sampled directly off the real PNG's flat interior fill (badge pill,
// footer strip, box row background) - all landed within a couple RGB
// values of each other, so one cover color is used for all three
// dynamic-text overlays rather than three near-identical constants.
const COVER_FILL = "#020712";

// Box left/right edge (shared by all 3 category boxes) - measured via a
// horizontal border-color scan at a header-row y.
const BOX_LEFT = 85;
const BOX_RIGHT = 933;

// Row center y (design-space) per category, measured via a jersey-icon
// bounding-box scan down each box - NOT a uniform template offset, since
// the 3rd box's rows landed ~5px lower than the same pattern applied to
// the other two (real variance in the generated art, not a bug).
const ROW_Y: Record<"winners" | "goals" | "cleanSheets", number[]> = {
  winners: [375, 426, 477, 529, 580],
  goals: [751, 802, 854, 906, 957],
  cleanSheets: [1131, 1183, 1234, 1287, 1338],
};

// Generic jersey-outline placeholder's own measured bounding box (row 1):
// x 172-209, y 355-395 - a real kit render is placed centered on the same
// midpoint (190, row_y) at a slightly larger, consistent square size so it
// fully covers the outline rather than peeking out from behind it.
const KIT_CENTER_X = 190;
const KIT_SIZE = 44;

const TEAM_NAME_LEFT = 232;
const VALUE_RIGHT = 900;
// Row content vertical box - centered on ROW_Y, tall enough for a single
// line of Oswald text without touching the next row's divider line
// (rows are ~51.5px apart).
const ROW_BOX_HEIGHT = 40;

// Badge pill interior (measured pill border bbox: x 654-935, y 81-140;
// inset a few px so the cover rect never paints over the pill's own
// stroke).
const BADGE_COVER = { left: 662, top: 89, width: 264, height: 43 };
// Footer text region - real bug found live 2026-08-21: an earlier
// measurement pass artificially windowed its own scan to x 440-650 and
// missed that "MARKET" actually starts around x 369, right where a
// flanking decorative rule-line sits close enough (<20px gap) to fuse
// with it in a real full-width scan - a narrower cover left "MARI"
// (the tail of "MARKET") visible next to the new overlaid text. This
// cover now spans the full measured run (rule + text + rule fragments,
// x 369-899) rather than just the text glyphs, so nothing baked
// survives underneath - the new text is centered alone in the wider
// gap without redrawing the small rule flourishes.
const FOOTER_COVER = { left: 350, top: 1422, width: 560, height: 42 };

export type MarketOddsCardRow = {
  teamName: string;
  kitDataUri: string | null;
  value: string;
};

export type MarketOddsCardInput = {
  gameweek: number;
  backgroundDataUri: string | null;
  winners: MarketOddsCardRow[];
  goals: MarketOddsCardRow[];
  cleanSheets: MarketOddsCardRow[];
};

export function buildMarketOddsCardElement(input: MarketOddsCardInput) {
  const { gameweek, backgroundDataUri, winners, goals, cleanSheets } = input;

  const label = (style: Record<string, unknown>, text: string) =>
    h("span", { style: { fontFamily: "Oswald", fontWeight: 500, textTransform: "uppercase", ...style } }, text);

  const heading = (style: Record<string, unknown>, text: string) =>
    h("span", { style: { fontFamily: "Oswald", fontWeight: 700, ...style } }, text);

  // One category's 5 rows (padded to 5 with nulls if real data came up
  // short, e.g. "no real odds posted yet") - each row overlays a real kit
  // + team name + value exactly on top of that row's baked rank number
  // and generic jersey outline.
  const categoryRows = (rows: MarketOddsCardRow[], yCenters: number[]) =>
    yCenters.map((y, i) => {
      const row = rows[i];
      if (!row) return null;
      return h(
        "div",
        {
          key: y,
          style: {
            display: "flex",
            alignItems: "center",
            position: "absolute",
            top: s(y - ROW_BOX_HEIGHT / 2),
            left: s(BOX_LEFT),
            width: s(BOX_RIGHT - BOX_LEFT),
            height: s(ROW_BOX_HEIGHT),
          },
        },
        row.kitDataUri
          ? h("img", {
              src: row.kitDataUri,
              width: s(KIT_SIZE),
              height: s(KIT_SIZE),
              style: {
                objectFit: "contain",
                position: "absolute",
                left: s(KIT_CENTER_X - BOX_LEFT - KIT_SIZE / 2),
                top: s((ROW_BOX_HEIGHT - KIT_SIZE) / 2),
              },
            })
          : null,
        heading(
          {
            fontSize: s(22),
            color: WHITE,
            position: "absolute",
            left: s(TEAM_NAME_LEFT - BOX_LEFT),
          },
          row.teamName
        ),
        heading(
          {
            fontSize: s(24),
            color: SKY_400,
            position: "absolute",
            left: s(VALUE_RIGHT - BOX_LEFT),
            transform: `translateX(-100%)`,
          },
          row.value
        )
      );
    });

  return h(
    "div",
    {
      style: {
        width: "100%",
        height: "100%",
        display: "flex",
        position: "relative",
        backgroundColor: "#03050b",
        fontFamily: "sans-serif",
      },
    },
    backgroundDataUri
      ? h("img", {
          src: backgroundDataUri,
          width: MARKET_ODDS_CARD_WIDTH,
          height: MARKET_ODDS_CARD_HEIGHT,
          style: { position: "absolute", top: 0, left: 0 },
        })
      : null,

    // header badge - covers the background's own baked "GW2" placeholder
    // with the real gameweek before drawing over it, so any gameweek
    // (not just the one baked into the sample art) renders correctly.
    h(
      "div",
      {
        style: {
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          position: "absolute",
          top: s(BADGE_COVER.top),
          left: s(BADGE_COVER.left),
          width: s(BADGE_COVER.width),
          height: s(BADGE_COVER.height),
          backgroundColor: COVER_FILL,
        },
      },
      label({ fontSize: s(20), color: NAVY_500, letterSpacing: s(2) }, `Market Odds · GW${gameweek}`)
    ),

    ...categoryRows(winners, ROW_Y.winners),
    ...categoryRows(goals, ROW_Y.goals),
    ...categoryRows(cleanSheets, ROW_Y.cleanSheets),

    // footer - same cover-then-redraw approach as the header badge.
    h(
      "div",
      {
        style: {
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          position: "absolute",
          top: s(FOOTER_COVER.top),
          left: s(FOOTER_COVER.left),
          width: s(FOOTER_COVER.width),
          height: s(FOOTER_COVER.height),
          backgroundColor: COVER_FILL,
        },
      },
      label({ fontSize: s(17), color: SKY_400, letterSpacing: s(2) }, `Market Odds · GW${gameweek}`)
    )
  ) as ReactNode;
}
