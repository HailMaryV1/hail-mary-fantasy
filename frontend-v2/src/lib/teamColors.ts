export type TeamColors = {
  primary: string;
  secondary: string;
  abbr: string;
  striped?: boolean;
};

// Real, public club kit colors and short codes - facts, not artwork, so no
// licensing concern. Ported from the original frontend's teamColors.ts.
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
};

const FALLBACK: TeamColors = { primary: "#1E2E45", secondary: "#7E93AB", abbr: "?" };

export function getTeamColors(teamName: string): TeamColors {
  return TEAM_COLORS[teamName] ?? FALLBACK;
}
