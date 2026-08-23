import { formatRating, ratingTier, ratingBasisTag, type RatingBasis } from "@/lib/hailMaryRating";

// The one shared display for a player's Hail Mary Rating - reused by
// every pool table, PlayerInfoPanel, and PitchView chip. size="sm" is
// the compact form for dense table rows/pitch chips; size="lg" is the
// headline form for the player detail panel. basis is optional - pass
// it wherever the row has it (2026-08-23 user request, see
// ratingBasisTag's docstring) to show what really backs the number;
// omit it in tight spaces (pitch chips) where the tier pill already
// covers the space budget.
export default function HailMaryRatingBadge({
  rating,
  basis,
  size = "sm",
}: {
  rating: number | null | undefined;
  basis?: RatingBasis | null;
  size?: "sm" | "lg";
}) {
  const tier = ratingTier(rating);
  const basisTag = ratingBasisTag(basis);
  const numberClass = size === "lg" ? "text-xl font-bold" : "text-sm font-semibold";

  return (
    <span className="inline-flex items-center gap-1.5">
      <span className={`${numberClass} text-sky-400`}>{formatRating(rating)}</span>
      <span className="text-[10px] text-navy-500">/10</span>
      {tier && (
        <span
          title={`Hail Mary Rating: ${formatRating(rating)}/10`}
          className={`rounded-full px-2 py-0.5 text-[10px] font-semibold ${tier.toneClass}`}
        >
          {tier.label}
        </span>
      )}
      {basisTag && (
        <span title={basisTag.title} className={`rounded-full px-2 py-0.5 text-[10px] font-semibold ${basisTag.toneClass}`}>
          {basisTag.label}
        </span>
      )}
    </span>
  );
}
