/**
 * Dependency-free SVG line chart - no charting library added (matches
 * this app's existing pattern of hand-drawn SVG, see Kit.tsx's jersey
 * path), used for both a single player's projection trend
 * (PlayerInfoPanel.tsx) and a squad's total projected-points trend
 * (DreamTeamBoard.tsx). Purely presentational - every number it renders
 * is computed by the caller.
 */
export type TrendChartPoint = { label: string; value: number };

const WIDTH = 280;
const HEIGHT = 90;
const PAD_X = 8;
const PAD_TOP = 10;
const PAD_BOTTOM = 20;

export default function TrendChart({ points, accent = "#38bdf8" }: { points: TrendChartPoint[]; accent?: string }) {
  if (points.length === 0) {
    return <p className="text-xs text-navy-500">No projection data yet.</p>;
  }

  const values = points.map((p) => p.value);
  const max = Math.max(...values, 0.1);
  const min = Math.min(...values, 0);
  const range = max - min || 1;
  const plotWidth = WIDTH - PAD_X * 2;
  const plotHeight = HEIGHT - PAD_TOP - PAD_BOTTOM;
  const stepX = points.length > 1 ? plotWidth / (points.length - 1) : 0;

  const coords = points.map((p, i) => ({
    x: PAD_X + stepX * i,
    y: PAD_TOP + plotHeight - ((p.value - min) / range) * plotHeight,
    ...p,
  }));

  const linePath = coords.map((c, i) => `${i === 0 ? "M" : "L"} ${c.x.toFixed(1)} ${c.y.toFixed(1)}`).join(" ");
  const areaPath = `${linePath} L ${coords[coords.length - 1].x.toFixed(1)} ${PAD_TOP + plotHeight} L ${coords[0].x.toFixed(1)} ${PAD_TOP + plotHeight} Z`;

  return (
    <svg viewBox={`0 0 ${WIDTH} ${HEIGHT}`} className="w-full" role="img" aria-label="Projected points trend">
      <path d={areaPath} fill={accent} fillOpacity={0.12} />
      <path d={linePath} fill="none" stroke={accent} strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" />
      {coords.map((c, i) => (
        <g key={i}>
          <circle cx={c.x} cy={c.y} r={2.5} fill={accent} />
          <text x={c.x} y={HEIGHT - 6} textAnchor="middle" className="fill-navy-500" style={{ fontSize: 9 }}>
            {c.label}
          </text>
          <text x={c.x} y={Math.max(c.y - 6, 9)} textAnchor="middle" className="fill-navy-300" style={{ fontSize: 9, fontWeight: 600 }}>
            {c.value.toFixed(1)}
          </text>
        </g>
      ))}
    </svg>
  );
}
