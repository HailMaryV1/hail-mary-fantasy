import { getTeamColors } from "@/lib/teamColors";

// One reusable jersey silhouette (collar notch, short sleeves, body) -
// hand-drawn, not copied from anywhere, so filling it with a club's real
// colors carries no licensing risk.
const JERSEY_PATH =
  "M35 12 L22 22 L8 30 L18 42 L30 32 L30 92 L70 92 L70 32 L82 42 L92 30 L78 22 L65 12 Q50 26 35 12 Z";

const SIZE_CLASSES = {
  sm: "h-5 w-5",
  lg: "h-6 w-6 sm:h-8 sm:w-8 md:h-10 md:w-10",
} as const;

export default function Kit({ teamName, size = "lg" }: { teamName: string; size?: "sm" | "lg" }) {
  const { primary, secondary, striped } = getTeamColors(teamName);
  const clipId = `kit-clip-${teamName.replace(/[^a-zA-Z0-9]/g, "")}-${size}`;

  return (
    <svg viewBox="0 0 100 100" aria-hidden="true" className={`shrink-0 ${SIZE_CLASSES[size]}`}>
      {striped ? (
        <>
          <clipPath id={clipId}>
            <path d={JERSEY_PATH} />
          </clipPath>
          <g clipPath={`url(#${clipId})`}>
            <rect x="0" y="0" width="100" height="100" fill={primary} />
            {[8, 29, 50, 71].map((x) => (
              <rect key={x} x={x} y="0" width="10.5" height="100" fill={secondary} />
            ))}
          </g>
        </>
      ) : (
        <path d={JERSEY_PATH} fill={primary} />
      )}
      <path d={JERSEY_PATH} fill="none" stroke={secondary} strokeWidth="3" strokeLinejoin="round" />
    </svg>
  );
}
