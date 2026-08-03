import { createServiceSupabaseClient } from "@/lib/supabaseServiceClient";
import { fernetEncrypt } from "@/lib/fernet";

/**
 * Receives a real FanTeam access token from the bookmarklet described on
 * /games/fanteam/sync-setup, after the account owner has logged into
 * FanTeam themselves in their own browser (passing FanTeam's own
 * reCAPTCHA the normal way - this endpoint never attempts a FanTeam
 * login itself, it only relays a token a real human session already
 * holds). Runs cross-origin from fanteam.com's own page, so this needs
 * its own CORS handling and its own secret-based auth - there's no Hail
 * Mary session cookie available from that origin.
 *
 * Stores the token the same way scripts/sync_provider_squads.py already
 * does for Cloud FF's cached-token path (provider_credentials.
 * encrypted_access_token / access_token_expires_at) - sync_fanteam picks
 * it up from there on its next run, never logging in itself.
 *
 * Also stores refreshToken (optional - encrypted_refresh_token, already
 * on the migration 0071 schema but unused until now) when the bookmarklet
 * found one - confirmed live (2026-08-03) that ftToken alone isn't enough
 * for FanTeam's own app to render a logged-in session in a fresh
 * Playwright context; see open_authenticated_page's docstring in
 * provider_fanteam_scoutgg.py for the evidence trail.
 */

// Both confirmed live (2026-08-03): the marketing homepage serves from
// www.fanteam.com, but a real logged-in session's own dashboard/entries
// pages (where the bookmarklet actually gets clicked) serve from the
// bare fanteam.com - no www. A single hardcoded ACAO value silently
// mismatched the real Origin header for exactly the page the bookmarklet
// is meant to run on, making every real click fail client-side with a
// bare "Failed to fetch" (the browser rejects the response before the
// bookmarklet's own .then()/.catch() ever sees an HTTP status) - the
// server was actually never reached in a way the browser would accept.
const FANTEAM_ORIGINS = ["https://fanteam.com", "https://www.fanteam.com"];
// FanTeam's real token lifetime is ~3h (see provider_fanteam_scoutgg.py's
// module docstring) - a 15-minute safety margin means sync_fanteam always
// sees a token as expired slightly before FanTeam itself would reject it,
// never the other way around.
const TOKEN_LIFETIME_MS = (3 * 60 - 15) * 60 * 1000;
const JWT_SHAPE = /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/;

function corsHeaders(origin: string | null) {
  const allowedOrigin = origin && FANTEAM_ORIGINS.includes(origin) ? origin : FANTEAM_ORIGINS[0];
  return {
    "Access-Control-Allow-Origin": allowedOrigin,
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
    Vary: "Origin",
  };
}

export async function OPTIONS(request: Request) {
  return new Response(null, { status: 204, headers: corsHeaders(request.headers.get("origin")) });
}

export async function POST(request: Request) {
  const headers = corsHeaders(request.headers.get("origin"));

  const expectedSecret = process.env.FANTEAM_BOOKMARKLET_SECRET;
  if (!expectedSecret) {
    return Response.json({ error: "Server not configured (FANTEAM_BOOKMARKLET_SECRET missing)." }, { status: 500, headers });
  }

  let body: { secret?: string; token?: string; refreshToken?: string | null };
  try {
    body = await request.json();
  } catch {
    return Response.json({ error: "Invalid JSON body." }, { status: 400, headers });
  }

  if (body.secret !== expectedSecret) {
    return Response.json({ error: "Invalid secret." }, { status: 401, headers });
  }
  if (!body.token || !JWT_SHAPE.test(body.token)) {
    return Response.json({ error: "Missing or malformed token." }, { status: 400, headers });
  }

  const providerSecretsKey = process.env.PROVIDER_SECRETS_KEY;
  if (!providerSecretsKey) {
    return Response.json({ error: "Server not configured (PROVIDER_SECRETS_KEY missing)." }, { status: 500, headers });
  }

  const supabase = createServiceSupabaseClient();
  const { data: users, error: userError } = await supabase.auth.admin.listUsers();
  if (userError || !users || users.users.length !== 1) {
    return Response.json(
      { error: `Expected exactly one Hail Mary user, found ${users?.users.length ?? 0}.` },
      { status: 500, headers }
    );
  }
  const userId = users.users[0].id;

  const encryptedToken = fernetEncrypt(providerSecretsKey, body.token);
  const encryptedRefreshToken = body.refreshToken ? fernetEncrypt(providerSecretsKey, body.refreshToken) : null;
  const expiresAt = new Date(Date.now() + TOKEN_LIFETIME_MS).toISOString();

  const { error: upsertError } = await supabase.from("provider_credentials").upsert(
    {
      user_id: userId,
      provider: "fanteam_scoutgg",
      auth_method: "encrypted_password",
      encrypted_access_token: encryptedToken,
      encrypted_refresh_token: encryptedRefreshToken,
      access_token_expires_at: expiresAt,
      last_refreshed_at: new Date().toISOString(),
      last_refresh_error: null,
      updated_at: new Date().toISOString(),
    },
    { onConflict: "user_id,provider" }
  );
  if (upsertError) {
    return Response.json({ error: upsertError.message }, { status: 500, headers });
  }

  return Response.json({ ok: true, expiresAt }, { status: 200, headers });
}
