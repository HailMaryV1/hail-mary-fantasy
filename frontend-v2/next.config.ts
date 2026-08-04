import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  experimental: {
    // Same rationale as the original frontend's next.config.ts: every page
    // here renders live, per-user Supabase data - no static content that
    // benefits from Next's default 5-minute client prefetch cache.
    staleTimes: {
      dynamic: 0,
      static: 30,
    },
  },
};

export default nextConfig;
