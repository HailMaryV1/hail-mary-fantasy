/**
 * foulsSampleBoard.ts
 * ---------------------------------------------------------------------------
 * A real, complete fouls board captured from the bookmaker on 2026-08-24:
 * Fulham v Chelsea, both ladders and both posted formations.
 *
 * Kept in the repo as the engine's reference fixture. Every number was
 * transcribed from the live board, including the awkward parts that a
 * hand-built fixture would smooth over and that the maths has to survive:
 *
 *   - suspended rungs, which thin out the deeper lines for most players
 *   - Palacios' to-be-fouled ladder, where 2+ is suspended but 3+ is priced,
 *     leaving a hole in the middle of the survival curve
 *   - odds-on favourites (Joao Pedro 1/16) where a multiplicative margin model
 *     would push implied probability above 1
 *
 * The page seeds itself from this so the tool is never a blank box, and it
 * doubles as the fixture the verification script runs against.
 */

import type { Board, PlayerLadder, OddsQuote } from "./foulsEdge";
import { toDecimal } from "./foulsEdge";
import type { Formation } from "./foulsMatchup";

export const FULHAM = "Fulham";
export const CHELSEA = "Chelsea";

/** "1/10 1/2 6/4 7/2 -" -> ladder quotes; "-" marks a suspended rung. */
function ladder(name: string, team: string, shirt: number, prices: string): PlayerLadder {
  const quotes: OddsQuote[] = prices
    .trim()
    .split(/\s+/)
    .map((raw, i) => {
      const suspended = raw === "-" || raw === "x";
      return {
        line: i + 1,
        fractional: suspended ? null : raw,
        decimal: suspended ? null : toDecimal(raw),
        suspended,
      };
    });
  return { name, team, shirt, quotes };
}

export const SAMPLE_BOARD: Board = {
  home: FULHAM,
  away: CHELSEA,
  kickoff: "2026-08-24",
  committed: [
    ladder("Cesar Palacios", FULHAM, 8, "1/10 1/2 6/4 7/2 10/1"),
    ladder("Morgan Rogers", CHELSEA, 17, "2/9 1/1 3/1 9/1 22/1"),
    ladder("Sander Berge", FULHAM, 16, "2/9 1/1 10/3 10/1 22/1"),
    ladder("Joao Pedro", CHELSEA, 9, "1/4 6/5 7/2 12/1 25/1"),
    ladder("Jorge Cuenca", FULHAM, 4, "1/4 11/10 10/3 10/1 25/1"),
    ladder("Romeo Lavia", CHELSEA, 45, "1/4 6/5 7/2 10/1 25/1"),
    ladder("Timothy Castagne", FULHAM, 21, "2/7 5/4 4/1 12/1 -"),
    ladder("Joshua King", FULHAM, 24, "1/3 6/4 5/1 14/1 -"),
    ladder("Malo Gusto", CHELSEA, 27, "1/3 13/8 5/1 16/1 -"),
    ladder("Oscar Bobb", FULHAM, 14, "1/3 6/4 5/1 14/1 -"),
    ladder("Antonee Robinson", FULHAM, 33, "4/11 13/8 11/2 16/1 -"),
    ladder("Reece James", CHELSEA, 24, "2/5 7/4 6/1 18/1 -"),
    ladder("Maxence Lacroix", CHELSEA, 5, "4/9 2/1 7/1 20/1 -"),
    ladder("Gonzalo Garcia", FULHAM, 7, "1/2 12/5 8/1 22/1 -"),
    ladder("Jorrel Hato", CHELSEA, 21, "1/2 9/4 8/1 22/1 -"),
    ladder("Josh Acheampong", CHELSEA, 34, "1/2 9/4 8/1 22/1 -"),
    ladder("Levi Colwill", CHELSEA, 6, "1/2 9/4 8/1 22/1 -"),
    ladder("Calvin Bassey", FULHAM, 3, "8/15 5/2 9/1 25/1 -"),
    ladder("Alex Iwobi", FULHAM, 17, "4/5 7/2 14/1 - -"),
    ladder("Cole Palmer", CHELSEA, 10, "5/6 4/1 16/1 - -"),
  ],
  toBeFouled: [
    ladder("Joao Pedro", CHELSEA, 9, "1/16 1/3 1/1 5/2 6/1"),
    ladder("Gonzalo Garcia", FULHAM, 7, "1/10 1/2 6/4 7/2 9/1"),
    ladder("Cole Palmer", CHELSEA, 10, "1/9 8/15 13/8 9/2 10/1"),
    ladder("Morgan Rogers", CHELSEA, 17, "1/8 8/13 7/4 5/1 12/1"),
    ladder("Cesar Palacios", FULHAM, 8, "1/7 - 2/1 11/2 14/1"),
    ladder("Joshua King", FULHAM, 24, "1/6 4/5 12/5 7/1 18/1"),
    ladder("Calvin Bassey", FULHAM, 3, "2/9 1/1 3/1 9/1 22/1"),
    ladder("Romeo Lavia", CHELSEA, 45, "3/10 11/8 9/2 14/1 -"),
    ladder("Josh Acheampong", CHELSEA, 34, "4/11 13/8 11/2 16/1 -"),
    ladder("Reece James", CHELSEA, 24, "4/11 13/8 11/2 16/1 -"),
    ladder("Oscar Bobb", FULHAM, 14, "2/5 7/4 6/1 18/1 -"),
    ladder("Malo Gusto", CHELSEA, 27, "4/9 2/1 7/1 20/1 -"),
    ladder("Alex Iwobi", FULHAM, 17, "8/13 11/4 10/1 - -"),
    ladder("Maxence Lacroix", CHELSEA, 5, "4/6 3/1 12/1 - -"),
    ladder("Timothy Castagne", FULHAM, 21, "4/5 4/1 14/1 - -"),
    ladder("Jorrel Hato", CHELSEA, 21, "5/6 9/2 16/1 - -"),
    ladder("Levi Colwill", CHELSEA, 6, "5/6 9/2 16/1 - -"),
    ladder("Sander Berge", FULHAM, 16, "5/6 9/2 18/1 - -"),
    ladder("Antonee Robinson", FULHAM, 33, "11/10 6/1 22/1 - -"),
    ladder("Jorge Cuenca", FULHAM, 4, "11/8 8/1 - - -"),
  ],
};

/**
 * Fulham 4-2-3-1, read off the posted graphic. Flanks are given from the
 * player's own perspective (Robinson, the left-back, is "L"); foulsMatchup.ts
 * maps those onto absolute touchlines so the two teams line up against each
 * other correctly.
 */
export const FULHAM_FORMATION: Formation = {
  team: FULHAM,
  shape: "4-2-3-1",
  slots: [
    { name: "Bernd Leno", team: FULHAM, shirt: 1, role: "GK", flank: "C" },
    { name: "Antonee Robinson", team: FULHAM, shirt: 33, role: "DEF", flank: "L" },
    { name: "Jorge Cuenca", team: FULHAM, shirt: 4, role: "DEF", flank: "C" },
    { name: "Calvin Bassey", team: FULHAM, shirt: 3, role: "DEF", flank: "C" },
    { name: "Timothy Castagne", team: FULHAM, shirt: 21, role: "DEF", flank: "R" },
    { name: "Sander Berge", team: FULHAM, shirt: 16, role: "MID", flank: "C" },
    { name: "Joshua King", team: FULHAM, shirt: 24, role: "MID", flank: "C" },
    { name: "Alex Iwobi", team: FULHAM, shirt: 17, role: "MID", flank: "C" },
    { name: "Cesar Palacios", team: FULHAM, shirt: 8, role: "MID", flank: "L" },
    { name: "Oscar Bobb", team: FULHAM, shirt: 14, role: "MID", flank: "R" },
    { name: "Gonzalo Garcia", team: FULHAM, shirt: 7, role: "FWD", flank: "C" },
  ],
};

/** Chelsea 3-4-3, same convention. */
export const CHELSEA_FORMATION: Formation = {
  team: CHELSEA,
  shape: "3-4-3",
  slots: [
    { name: "Robert Sanchez", team: CHELSEA, shirt: 1, role: "GK", flank: "C" },
    { name: "Josh Acheampong", team: CHELSEA, shirt: 34, role: "DEF", flank: "R" },
    { name: "Maxence Lacroix", team: CHELSEA, shirt: 5, role: "DEF", flank: "C" },
    { name: "Levi Colwill", team: CHELSEA, shirt: 6, role: "DEF", flank: "L" },
    { name: "Malo Gusto", team: CHELSEA, shirt: 27, role: "MID", flank: "R" },
    { name: "Reece James", team: CHELSEA, shirt: 24, role: "MID", flank: "C" },
    { name: "Romeo Lavia", team: CHELSEA, shirt: 45, role: "MID", flank: "C" },
    { name: "Jorrel Hato", team: CHELSEA, shirt: 21, role: "MID", flank: "L" },
    { name: "Cole Palmer", team: CHELSEA, shirt: 10, role: "FWD", flank: "R" },
    { name: "Joao Pedro", team: CHELSEA, shirt: 9, role: "FWD", flank: "C" },
    { name: "Morgan Rogers", team: CHELSEA, shirt: 17, role: "FWD", flank: "L" },
  ],
};

/* ========================================================================== *
 * Paste-mode defaults
 * ========================================================================== */

/**
 * The same reference board in the text form the paste inputs accept, so the
 * page is never a blank box and the expected format is demonstrated rather
 * than described. A "-" marks a suspended rung, including Palacios' interior
 * gap at 2+ which the parser cannot otherwise recover.
 */
export const DEFAULT_COMMITTED = `8 Cesar Palacios 1/10 1/2 6/4 7/2 10/1
17 Morgan Rogers 2/9 1/1 3/1 9/1 22/1
16 Sander Berge 2/9 1/1 10/3 10/1 22/1
9 Joao Pedro 1/4 6/5 7/2 12/1 25/1
4 Jorge Cuenca 1/4 11/10 10/3 10/1 25/1
45 Romeo Lavia 1/4 6/5 7/2 10/1 25/1
21 Timothy Castagne 2/7 5/4 4/1 12/1 -
24 Joshua King 1/3 6/4 5/1 14/1 -
27 Malo Gusto 1/3 13/8 5/1 16/1 -
14 Oscar Bobb 1/3 6/4 5/1 14/1 -
33 Antonee Robinson 4/11 13/8 11/2 16/1 -
24 Reece James 2/5 7/4 6/1 18/1 -
5 Maxence Lacroix 4/9 2/1 7/1 20/1 -
7 Gonzalo Garcia 1/2 12/5 8/1 22/1 -
21 Jorrel Hato 1/2 9/4 8/1 22/1 -
34 Josh Acheampong 1/2 9/4 8/1 22/1 -
6 Levi Colwill 1/2 9/4 8/1 22/1 -
3 Calvin Bassey 8/15 5/2 9/1 25/1 -
17 Alex Iwobi 4/5 7/2 14/1 - -
10 Cole Palmer 5/6 4/1 16/1 - -`;

export const DEFAULT_FOULED = `9 Joao Pedro 1/16 1/3 1/1 5/2 6/1
7 Gonzalo Garcia 1/10 1/2 6/4 7/2 9/1
10 Cole Palmer 1/9 8/15 13/8 9/2 10/1
17 Morgan Rogers 1/8 8/13 7/4 5/1 12/1
8 Cesar Palacios 1/7 - 2/1 11/2 14/1
24 Joshua King 1/6 4/5 12/5 7/1 18/1
3 Calvin Bassey 2/9 1/1 3/1 9/1 22/1
45 Romeo Lavia 3/10 11/8 9/2 14/1 -
34 Josh Acheampong 4/11 13/8 11/2 16/1 -
24 Reece James 4/11 13/8 11/2 16/1 -
14 Oscar Bobb 2/5 7/4 6/1 18/1 -
27 Malo Gusto 4/9 2/1 7/1 20/1 -
17 Alex Iwobi 8/13 11/4 10/1 - -
5 Maxence Lacroix 4/6 3/1 12/1 - -
21 Timothy Castagne 4/5 4/1 14/1 - -
21 Jorrel Hato 5/6 9/2 16/1 - -
6 Levi Colwill 5/6 9/2 16/1 - -
16 Sander Berge 5/6 9/2 18/1 - -
33 Antonee Robinson 11/10 6/1 22/1 - -
4 Jorge Cuenca 11/8 8/1 - - -`;

export const DEFAULT_HOME_SHEET = `Bernd Leno, GK, C
Antonee Robinson, DEF, L
Jorge Cuenca, DEF, C
Calvin Bassey, DEF, C
Timothy Castagne, DEF, R
Sander Berge, MID, C
Joshua King, MID, C
Alex Iwobi, MID, C
Cesar Palacios, MID, L
Oscar Bobb, MID, R
Gonzalo Garcia, FWD, C`;

export const DEFAULT_AWAY_SHEET = `Robert Sanchez, GK, C
Josh Acheampong, DEF, R
Maxence Lacroix, DEF, C
Levi Colwill, DEF, L
Malo Gusto, MID, R
Reece James, MID, C
Romeo Lavia, MID, C
Jorrel Hato, MID, L
Cole Palmer, FWD, R
Joao Pedro, FWD, C
Morgan Rogers, FWD, L`;
