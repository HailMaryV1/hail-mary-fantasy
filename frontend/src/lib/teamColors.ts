export type TeamColors = {
  primary: string;
  secondary: string;
  abbr: string;
  striped?: boolean;
};

// Real, public club kit colors and short codes - facts, not artwork, so
// no licensing concern (unlike the official kit/badge SVGs FanTeam itself
// serves from fantasy.assets.scoutgg.net, which we deliberately don't
// use - see the plan this was built from). Covers every club that
// currently appears in either game's player pool (confirmed via a direct
// query joining game_players/players/teams for both fanteam and
// dreamteam). striped: true only for clubs whose kit identity is
// genuinely stripe-based, so Kit.tsx renders something recognisable
// instead of every club looking like a plain block of color.
export const TEAM_COLORS: Record<string, TeamColors> = {
  Arsenal: { primary: "#EF0107", secondary: "#FFFFFF", abbr: "ARS" },
  "Aston Villa": { primary: "#670E36", secondary: "#95BFE5", abbr: "AVL" },
  Bournemouth: { primary: "#DA291C", secondary: "#000000", abbr: "BOU", striped: true },
  Brentford: { primary: "#D71920", secondary: "#FFFFFF", abbr: "BRE", striped: true },
  Brighton: { primary: "#0057B8", secondary: "#FFFFFF", abbr: "BHA", striped: true },
  Burnley: { primary: "#6C1D45", secondary: "#99D6EA", abbr: "BUR" },
  Chelsea: { primary: "#034694", secondary: "#FFFFFF", abbr: "CHE" },
  "Coventry City": { primary: "#78D0F3", secondary: "#000000", abbr: "COV" },
  "Crystal Palace": { primary: "#1B458F", secondary: "#C4122E", abbr: "CRY", striped: true },
  Everton: { primary: "#003399", secondary: "#FFFFFF", abbr: "EVE" },
  Fulham: { primary: "#FFFFFF", secondary: "#000000", abbr: "FUL" },
  "Hull City": { primary: "#F5A50A", secondary: "#000000", abbr: "HUL", striped: true },
  "Ipswich Town": { primary: "#0044A9", secondary: "#FFFFFF", abbr: "IPS" },
  "Leeds United": { primary: "#FFFFFF", secondary: "#1D428A", abbr: "LEE" },
  Liverpool: { primary: "#C8102E", secondary: "#FFFFFF", abbr: "LIV" },
  "Manchester City": { primary: "#6CABDD", secondary: "#1C2C5B", abbr: "MCI" },
  "Manchester United": { primary: "#DA291C", secondary: "#000000", abbr: "MUN" },
  "Newcastle United": { primary: "#241F20", secondary: "#FFFFFF", abbr: "NEW", striped: true },
  "Nottingham Forest": { primary: "#DD0000", secondary: "#FFFFFF", abbr: "NFO" },
  Sunderland: { primary: "#EB172B", secondary: "#FFFFFF", abbr: "SUN", striped: true },
  "Tottenham Hotspur": { primary: "#FFFFFF", secondary: "#132257", abbr: "TOT" },
  "West Ham United": { primary: "#7A263A", secondary: "#1BB1E7", abbr: "WHU" },
  "Wolverhampton Wanderers": { primary: "#FDB913", secondary: "#231F20", abbr: "WOL" },

  // NFL - real, public team colors, same "facts not artwork" basis as the
  // soccer clubs above. Covers all 32 teams seeded for NFL FanTeam.
  "Arizona Cardinals": { primary: "#97233F", secondary: "#000000", abbr: "ARI" },
  "Atlanta Falcons": { primary: "#A71930", secondary: "#000000", abbr: "ATL" },
  "Baltimore Ravens": { primary: "#241773", secondary: "#000000", abbr: "BAL" },
  "Buffalo Bills": { primary: "#00338D", secondary: "#C60C30", abbr: "BUF" },
  "Carolina Panthers": { primary: "#0085CA", secondary: "#101820", abbr: "CAR" },
  "Chicago Bears": { primary: "#0B162A", secondary: "#C83803", abbr: "CHI" },
  "Cincinnati Bengals": { primary: "#FB4F14", secondary: "#000000", abbr: "CIN", striped: true },
  "Cleveland Browns": { primary: "#311D00", secondary: "#FF3C00", abbr: "CLE" },
  "Dallas Cowboys": { primary: "#003594", secondary: "#041E42", abbr: "DAL" },
  "Denver Broncos": { primary: "#FB4F14", secondary: "#002244", abbr: "DEN" },
  "Detroit Lions": { primary: "#0076B6", secondary: "#B0B7BC", abbr: "DET" },
  "Green Bay Packers": { primary: "#203731", secondary: "#FFB612", abbr: "GB" },
  "Houston Texans": { primary: "#03202F", secondary: "#A71930", abbr: "HOU" },
  "Indianapolis Colts": { primary: "#002C5F", secondary: "#A2AAAD", abbr: "IND" },
  "Jacksonville Jaguars": { primary: "#101820", secondary: "#D7A22A", abbr: "JAX" },
  "Kansas City Chiefs": { primary: "#E31837", secondary: "#FFB81C", abbr: "KC" },
  "Las Vegas Raiders": { primary: "#000000", secondary: "#A5ACAF", abbr: "LV" },
  "Los Angeles Chargers": { primary: "#0080C6", secondary: "#FFC20E", abbr: "LAC" },
  "Los Angeles Rams": { primary: "#003594", secondary: "#FFA300", abbr: "LAR" },
  "Miami Dolphins": { primary: "#008E97", secondary: "#FC4C02", abbr: "MIA" },
  "Minnesota Vikings": { primary: "#4F2683", secondary: "#FFC62F", abbr: "MIN" },
  "New England Patriots": { primary: "#002244", secondary: "#C60C30", abbr: "NE" },
  "New Orleans Saints": { primary: "#D3BC8D", secondary: "#101820", abbr: "NO" },
  "New York Giants": { primary: "#0B2265", secondary: "#A71930", abbr: "NYG" },
  "New York Jets": { primary: "#125740", secondary: "#000000", abbr: "NYJ" },
  "Philadelphia Eagles": { primary: "#004C54", secondary: "#A5ACAF", abbr: "PHI" },
  "Pittsburgh Steelers": { primary: "#FFB612", secondary: "#101820", abbr: "PIT" },
  "San Francisco 49ers": { primary: "#AA0000", secondary: "#B3995D", abbr: "SF" },
  "Seattle Seahawks": { primary: "#002244", secondary: "#69BE28", abbr: "SEA" },
  "Tampa Bay Buccaneers": { primary: "#D50A0A", secondary: "#34302B", abbr: "TB" },
  "Tennessee Titans": { primary: "#0C2340", secondary: "#4B92DB", abbr: "TEN" },
  "Washington Commanders": { primary: "#5A1414", secondary: "#FFB612", abbr: "WSH" },
};

const FALLBACK: TeamColors = { primary: "#1E2E45", secondary: "#7E93AB", abbr: "?" };

export function getTeamColors(teamName: string): TeamColors {
  return TEAM_COLORS[teamName] ?? FALLBACK;
}
