"use client";

import Image from "next/image";
import Link from "next/link";
import { useRouter } from "next/navigation";
import PushNotificationToggle from "./PushNotificationToggle";

// Shared header for every page inside a game's route tree (wired in via a
// layout.tsx per top-level segment - see dreamteam/fanteam/cloudff/golf/
// eflfantasy/games layout.tsx files - so this renders once per section
// rather than being pasted into every page). router.back() covers "go to
// wherever I actually came from"; the pill next to it always goes home,
// even if that history is empty (e.g. a deep-linked page).
export default function PageHeader() {
  const router = useRouter();

  return (
    <header className="sticky top-0 z-30 flex items-center justify-between gap-3 border-b border-navy-800 bg-navy-950/90 px-4 py-2.5 backdrop-blur-sm sm:px-6">
      <Link href="/" className="flex shrink-0 items-center gap-2">
        <Image src="/logo.png" alt="Hail Mary" width={28} height={29} priority />
        <span className="hidden text-sm font-bold tracking-wide text-white sm:inline">HAIL MARY</span>
      </Link>

      <div className="flex items-center gap-2">
        <PushNotificationToggle />
        <button
          onClick={() => router.back()}
          className="rounded-md border border-navy-700 px-3 py-1.5 text-xs font-medium text-navy-200 transition-colors hover:border-sky-500 hover:text-sky-300"
        >
          ← Back
        </button>
        <Link
          href="/"
          className="rounded-md bg-sky-600 px-3 py-1.5 text-xs font-semibold text-white transition-colors hover:bg-sky-500"
        >
          Back to Main Menu
        </Link>
      </div>
    </header>
  );
}
