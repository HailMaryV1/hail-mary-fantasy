"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

export default function NavGameLinks({ games }: { games: { slug: string; display_name: string }[] }) {
  const pathname = usePathname();

  return (
    <>
      {games.map((g) => {
        const href = `/games/${g.slug}`;
        const active = pathname.startsWith(href);
        return (
          <Link
            key={g.slug}
            href={href}
            className={`shrink-0 transition-colors ${active ? "text-sky-300" : "text-navy-300 hover:text-sky-300"}`}
          >
            {g.display_name}
          </Link>
        );
      })}
    </>
  );
}
