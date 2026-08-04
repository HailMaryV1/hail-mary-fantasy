import Image from "next/image";
import Link from "next/link";
import { redirect } from "next/navigation";
import { createAuthServerClient } from "@/lib/supabaseServerClient";

// Same reasoning as the original site's landing page: this route is
// per-user (redirects to /login when signed out), so it must never be
// served from Next's static/data cache.
export const dynamic = "force-dynamic";

export default async function LandingPage() {
  const supabase = await createAuthServerClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) redirect("/login");

  const { data: games } = await supabase.from("fantasy_games").select("slug, display_name").order("id");

  return (
    <div className="flex min-h-screen flex-col items-center justify-center gap-12 bg-navy-950 px-6">
      <Image src="/logo.png" alt="Hail Mary" width={140} height={145} priority />

      <nav className="flex flex-col items-center gap-1">
        {(games ?? []).map((g) => (
          <Link
            key={g.slug}
            href={`/games/${g.slug}`}
            className="px-4 py-3 text-xl font-medium text-navy-200 transition-colors hover:text-sky-400"
          >
            {g.display_name}
          </Link>
        ))}
      </nav>
    </div>
  );
}
