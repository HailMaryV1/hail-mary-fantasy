import type { WatchlistAlert } from "@/lib/watchlistAlerts";

const TONE_CLASSES = {
  good: "border-emerald-900 bg-emerald-950/40 text-emerald-300",
  bad: "border-red-900 bg-red-950/40 text-red-300",
  info: "border-navy-700 bg-navy-900 text-navy-300",
} as const;

export default function WatchlistAlerts({ alerts }: { alerts: WatchlistAlert[] }) {
  if (alerts.length === 0) return null;

  return (
    <div className="mb-6 flex flex-col gap-2">
      {alerts.map((alert) => (
        <p key={alert.id} className={`rounded-lg border px-3 py-2 text-sm ${TONE_CLASSES[alert.tone]}`}>
          {alert.message}
        </p>
      ))}
    </div>
  );
}
