import { getTeamColors } from "@/lib/teamColors";

const SIZES = { sm: 20, lg: 32 } as const;

export default function Badge({ teamName, size = "sm" }: { teamName: string; size?: "sm" | "lg" }) {
  const { primary, secondary, abbr } = getTeamColors(teamName);
  const px = SIZES[size];

  return (
    <svg width={px} height={px} viewBox="0 0 32 32" aria-hidden="true" className="inline-block shrink-0">
      <circle cx="16" cy="16" r="15" fill={primary} stroke={secondary} strokeWidth="2" />
      <text
        x="16"
        y="17"
        textAnchor="middle"
        dominantBaseline="middle"
        fontSize="10"
        fontWeight="700"
        fill={secondary}
        fontFamily="sans-serif"
      >
        {abbr}
      </text>
    </svg>
  );
}
