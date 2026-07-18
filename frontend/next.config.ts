import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  experimental: {
    // Every page here renders from live, personalized Supabase data (scores,
    // squads, prices) - there's no static/marketing content that benefits
    // from the default 5-minute client prefetch cache. Without this,
    // clicking a Link whose target was already prefetched (e.g. the
    // Short/Medium/Long horizon toggle - all three are in the viewport at
    // once, so all three get prefetched) serves the stale cached RSC
    // payload instead of re-fetching, even though the URL updates
    // instantly - caught via a real click-through test showing the score
    // frozen at the previous horizon's value while the label text (derived
    // from searchParams, not the cached fetch) updated correctly.
    staleTimes: {
      dynamic: 0,
      static: 30,
    },
  },
};

export default nextConfig;
