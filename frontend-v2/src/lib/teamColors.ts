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

  // EFL Championship/League One/League Two clubs (2026-08-21 user report -
  // these fell back to the generic "?" badge everywhere, since this file
  // only ever covered the Premier League). Cross-checked against the real
  // kit artwork already in frontend-v2/public/kits/*.png via pixel
  // extraction, backed by each club's well-known traditional identity
  // colors where a kit's white trim/shorts otherwise dominate the count.
  "Birmingham City": { primary: "#0000A0", secondary: "#FFFFFF", abbr: "BIR" },
  "Blackburn Rovers": { primary: "#009EE0", secondary: "#FFFFFF", abbr: "BLB", striped: true },
  "Bolton Wanderers": { primary: "#FFFFFF", secondary: "#01285E", abbr: "BOL" },
  "Bristol City": { primary: "#E21C21", secondary: "#FFFFFF", abbr: "BRC" },
  "Cardiff City": { primary: "#0070B5", secondary: "#FFFFFF", abbr: "CAR" },
  "Charlton Athletic": { primary: "#D2122E", secondary: "#000000", abbr: "CHA" },
  "Derby County": { primary: "#FFFFFF", secondary: "#000000", abbr: "DER" },
  "Lincoln City": { primary: "#E2231A", secondary: "#000000", abbr: "LIN", striped: true },
  Middlesbrough: { primary: "#E4141B", secondary: "#FFFFFF", abbr: "MID" },
  Millwall: { primary: "#001C58", secondary: "#FFFFFF", abbr: "MIL" },
  "Norwich City": { primary: "#FFF200", secondary: "#00A650", abbr: "NOR" },
  Portsmouth: { primary: "#001489", secondary: "#FFFFFF", abbr: "POR" },
  "Preston North End": { primary: "#FFFFFF", secondary: "#001C58", abbr: "PNE" },
  "Queens Park Rangers": { primary: "#005DAA", secondary: "#FFFFFF", abbr: "QPR", striped: true },
  "Sheffield United": { primary: "#EE2737", secondary: "#FFFFFF", abbr: "SHU", striped: true },
  Southampton: { primary: "#D71920", secondary: "#FFFFFF", abbr: "SOU", striped: true },
  "Stoke City": { primary: "#E03A3E", secondary: "#FFFFFF", abbr: "STK", striped: true },
  "Swansea City": { primary: "#FFFFFF", secondary: "#000000", abbr: "SWA" },
  Watford: { primary: "#FBEE23", secondary: "#ED2127", abbr: "WAT" },
  "West Bromwich Albion": { primary: "#122F67", secondary: "#FFFFFF", abbr: "WBA", striped: true },
  Wrexham: { primary: "#C8102E", secondary: "#FFFFFF", abbr: "WRE" },
  "AFC Wimbledon": { primary: "#0044A9", secondary: "#FFD700", abbr: "AFW" },
  Barnsley: { primary: "#EE2737", secondary: "#FFFFFF", abbr: "BAR" },
  Blackpool: { primary: "#F68712", secondary: "#FFFFFF", abbr: "BLA" },
  "Bradford City": { primary: "#7A263A", secondary: "#FDB913", abbr: "BRA" },
  Bromley: { primary: "#FFFFFF", secondary: "#000000", abbr: "BRO" },
  "Burton Albion": { primary: "#FBEE23", secondary: "#000000", abbr: "BUT" },
  "Cambridge United": { primary: "#FDB913", secondary: "#000000", abbr: "CAM" },
  "Doncaster Rovers": { primary: "#E4141B", secondary: "#FFFFFF", abbr: "DON" },
  "Huddersfield Town": { primary: "#0E63AD", secondary: "#FFFFFF", abbr: "HUD", striped: true },
  "Leicester City": { primary: "#003090", secondary: "#FDBE11", abbr: "LEI" },
  "Leyton Orient": { primary: "#E2231A", secondary: "#000000", abbr: "LOR" },
  "Luton Town": { primary: "#F68712", secondary: "#001C58", abbr: "LUT" },
  "Mansfield Town": { primary: "#FBEE23", secondary: "#0000A0", abbr: "MAN" },
  "MK Dons": { primary: "#FFFFFF", secondary: "#000000", abbr: "MKD" },
  "Notts County": { primary: "#000000", secondary: "#FFFFFF", abbr: "NOT", striped: true },
  "Oxford United": { primary: "#FBEE23", secondary: "#001C58", abbr: "OXF" },
  "Peterborough United": { primary: "#0070B5", secondary: "#FFFFFF", abbr: "PET" },
  "Plymouth Argyle": { primary: "#00674B", secondary: "#FFFFFF", abbr: "PLY" },
  Reading: { primary: "#004494", secondary: "#FFFFFF", abbr: "REA", striped: true },
  "Sheffield Wednesday": { primary: "#0090D4", secondary: "#FFFFFF", abbr: "SHW", striped: true },
  Stevenage: { primary: "#E4141B", secondary: "#FFFFFF", abbr: "STE" },
  "Stockport County": { primary: "#0044A9", secondary: "#FFFFFF", abbr: "STO" },
  "Wigan Athletic": { primary: "#004494", secondary: "#FFFFFF", abbr: "WIG", striped: true },
  "Wycombe Wanderers": { primary: "#6CACE4", secondary: "#001C58", abbr: "WYC" },
  "Accrington Stanley": { primary: "#E4141B", secondary: "#000000", abbr: "ACC" },
  Barnet: { primary: "#FDB913", secondary: "#000000", abbr: "BNT" },
  "Bristol Rovers": { primary: "#0044A9", secondary: "#FFFFFF", abbr: "BRR", striped: true },
  "Cheltenham Town": { primary: "#E4141B", secondary: "#FFFFFF", abbr: "CHE" },
  Chesterfield: { primary: "#0044A9", secondary: "#FFFFFF", abbr: "CHF" },
  "Colchester United": { primary: "#004494", secondary: "#FFFFFF", abbr: "COL" },
  "Crawley Town": { primary: "#E4141B", secondary: "#000000", abbr: "CRA" },
  "Crewe Alexandra": { primary: "#E4141B", secondary: "#FFFFFF", abbr: "CRE" },
  "Exeter City": { primary: "#E4141B", secondary: "#FFFFFF", abbr: "EXE", striped: true },
  "Fleetwood Town": { primary: "#E4141B", secondary: "#000000", abbr: "FLE" },
  Gillingham: { primary: "#0044A9", secondary: "#FFFFFF", abbr: "GIL" },
  "Grimsby Town": { primary: "#000000", secondary: "#FFFFFF", abbr: "GRI", striped: true },
  "Newport County": { primary: "#FDB913", secondary: "#000000", abbr: "NEW" },
  "Northampton Town": { primary: "#7A263A", secondary: "#FFFFFF", abbr: "NTH" },
  "Oldham Athletic": { primary: "#004494", secondary: "#FFFFFF", abbr: "OLD" },
  "Port Vale": { primary: "#FFFFFF", secondary: "#000000", abbr: "PVA" },
  Rochdale: { primary: "#001C58", secondary: "#FFFFFF", abbr: "ROC" },
  "Rotherham United": { primary: "#E4141B", secondary: "#FFFFFF", abbr: "ROT" },
  "Salford City": { primary: "#E4141B", secondary: "#FDB913", abbr: "SAL" },
  "Shrewsbury Town": { primary: "#0044A9", secondary: "#FFB81C", abbr: "SHR" },
  "Swindon Town": { primary: "#E4141B", secondary: "#FFFFFF", abbr: "SWI" },
  "Tranmere Rovers": { primary: "#FFFFFF", secondary: "#001C58", abbr: "TRA" },
  Walsall: { primary: "#E4141B", secondary: "#FFFFFF", abbr: "WAL" },
  "York City": { primary: "#7A263A", secondary: "#FDB913", abbr: "YOR" },
};

const FALLBACK: TeamColors = { primary: "#1E2E45", secondary: "#7E93AB", abbr: "?" };

export function getTeamColors(teamName: string): TeamColors {
  return TEAM_COLORS[teamName] ?? FALLBACK;
}
