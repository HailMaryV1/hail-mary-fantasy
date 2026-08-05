"use client";

export type PlayerAction = {
  label: string;
  onClick: () => void;
  disabled?: boolean;
  tone?: "default" | "danger";
};

/**
 * First menu/popover in this app - a bottom sheet rather than a chip-
 * anchored dropdown, since the pitch chips it opens from (PitchView,
 * NflRosterView) are shared, presentational-only components with no
 * per-chip position/ref to anchor against. A fixed bottom sheet needs no
 * anchoring math, no portal, and works identically on mobile and desktop.
 */
export default function PlayerActionMenu({
  open,
  onClose,
  title,
  subtitle,
  actions,
}: {
  open: boolean;
  onClose: () => void;
  title: string;
  subtitle?: string;
  actions: PlayerAction[];
}) {
  if (!open) return null;

  return (
    <>
      <div className="fixed inset-0 z-40 bg-black/50" onClick={onClose} />
      <div className="fixed inset-x-0 bottom-0 z-50 rounded-t-2xl border-t border-navy-700 bg-navy-900 pb-[env(safe-area-inset-bottom)] shadow-lg sm:inset-x-auto sm:bottom-4 sm:left-1/2 sm:w-72 sm:-translate-x-1/2 sm:rounded-2xl sm:border">
        <div className="border-b border-navy-800 px-4 py-3">
          <p className="text-sm font-medium text-white">{title}</p>
          {subtitle && <p className="text-xs text-navy-400">{subtitle}</p>}
        </div>
        <div className="py-1">
          {actions.map((action) => (
            <button
              key={action.label}
              disabled={action.disabled}
              onClick={() => {
                onClose();
                action.onClick();
              }}
              className={`block w-full px-4 py-2.5 text-left text-sm transition-colors disabled:cursor-not-allowed disabled:opacity-40 ${
                action.tone === "danger" ? "text-red-400 hover:bg-navy-800" : "text-white hover:bg-navy-800"
              }`}
            >
              {action.label}
            </button>
          ))}
        </div>
        <button onClick={onClose} className="block w-full border-t border-navy-800 px-4 py-2.5 text-left text-sm text-navy-400 hover:bg-navy-800">
          Cancel
        </button>
      </div>
    </>
  );
}
