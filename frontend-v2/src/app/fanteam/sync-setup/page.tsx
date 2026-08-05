import Link from "next/link";
import { redirect } from "next/navigation";
import { createAuthServerClient } from "@/lib/supabaseServerClient";
import BookmarkletLink from "./BookmarkletLink";

/**
 * FanTeam's own login page runs Google reCAPTCHA, which blocks the
 * automated scripted login scripts/sync_provider_squads.py used to rely
 * on (see sync_fanteam's comment for the full incident). This page
 * doesn't try to get around that - it relays a token from a REAL, human
 * FanTeam login instead. Dragging the bookmarklet below to your
 * bookmarks bar, then clicking it while logged into FanTeam in that same
 * tab, reads the token FanTeam's own app already stored in that
 * browser's localStorage (the same key open_authenticated_page injects
 * for scripted DOM reads - see provider_fanteam_scoutgg.py) and sends it
 * to /api/fanteam-token, which stores it (encrypted) for the next
 * scheduled sync to pick up. Nothing here ever attempts a FanTeam login
 * itself.
 *
 * Also relays refreshToken (same localStorage key) when present -
 * ftToken alone, even a real, still-valid one, isn't enough for FanTeam's
 * own app to render a logged-in session in a fresh Playwright context;
 * the app's auth bootstrap needs refreshToken too (see
 * open_authenticated_page's docstring for the full evidence trail).
 * refreshToken is optional - a session that never set one still relays
 * ftToken alone, unchanged.
 */
export default async function FanteamSyncSetupPage() {
  const supabase = await createAuthServerClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) redirect("/login");

  const secret = process.env.FANTEAM_BOOKMARKLET_SECRET;
  const siteUrl = "https://hailmaryfantasysports.co.uk";

  const bookmarkletSource = secret
    ? `(function(){
  function isJwt(v){return typeof v==='string' && /^[A-Za-z0-9_-]+\\.[A-Za-z0-9_-]+\\.[A-Za-z0-9_-]+$/.test(v);}
  function findToken(){
    var known = localStorage.getItem('ftToken');
    if (isJwt(known)) return known;
    var stores = [localStorage, sessionStorage];
    for (var s = 0; s < stores.length; s++){
      var store = stores[s];
      for (var i = 0; i < store.length; i++){
        var v = store.getItem(store.key(i));
        if (isJwt(v)) return v;
      }
    }
    return null;
  }
  var token = findToken();
  if (!token){
    alert('Hail Mary: could not find a FanTeam login token in this tab. Make sure you are logged into FanTeam here, then click this again.');
    return;
  }
  var refreshToken = localStorage.getItem('refreshToken') || null;
  fetch('${siteUrl}/api/fanteam-token', {
    method: 'POST',
    headers: {'Content-Type': 'application/json'},
    body: JSON.stringify({secret: '${secret}', token: token, refreshToken: refreshToken})
  }).then(function(r){ return r.json(); }).then(function(data){
    if (data && data.ok) {
      alert('Hail Mary: FanTeam token sent! Your squads will sync within a few minutes.');
    } else {
      alert('Hail Mary: something went wrong - ' + (data && data.error ? data.error : 'unknown error'));
    }
  }).catch(function(e){
    alert('Hail Mary: request failed - ' + e.message);
  });
})();`
    : null;

  const bookmarkletHref = bookmarkletSource ? `javascript:${encodeURIComponent(bookmarkletSource)}` : null;

  return (
    <div className="min-h-screen bg-navy-950 px-6 py-10">
      <main className="mx-auto max-w-2xl">
        <Link href="/fanteam" className="text-sm text-navy-400 hover:text-sky-300">
          ← FanTeam
        </Link>
        <h1 className="mt-2 text-2xl font-semibold text-white">Keep FanTeam syncing</h1>
        <p className="mt-2 text-sm text-navy-300">
          FanTeam&apos;s login page runs Google reCAPTCHA, so the fully-automatic sync that works for Cloud FF
          can&apos;t log in on its own for FanTeam anymore - it would just get blocked, and repeatedly trying would
          be exactly the kind of automated traffic that check exists to stop. Instead, this page gives you a
          one-click bookmarklet: you log into FanTeam normally (passing reCAPTCHA the normal way, because it&apos;s
          really you), then click the bookmarklet to hand that session&apos;s token to Hail Mary. Nothing here ever
          logs into FanTeam by itself.
        </p>

        {!bookmarkletHref ? (
          <div className="mt-8 rounded-xl border border-red-900 bg-red-950/40 p-6">
            <p className="text-sm text-red-300">
              This page isn&apos;t configured yet - <code className="rounded bg-navy-800 px-1 py-0.5">FANTEAM_BOOKMARKLET_SECRET</code>{" "}
              is missing from the server environment.
            </p>
          </div>
        ) : (
          <>
            <div className="mt-8 rounded-xl border border-navy-700 bg-navy-900 p-6">
              <p className="text-xs font-semibold uppercase tracking-wide text-navy-400">Step 1</p>
              <p className="mt-1 text-sm text-navy-200">
                Drag this button up to your browser&apos;s bookmarks bar (it doesn&apos;t do anything just by
                clicking it here on this page).
              </p>
              <BookmarkletLink
                href={bookmarkletHref}
                className="mt-4 inline-flex cursor-move items-center gap-2 rounded-lg bg-sky-500 px-4 py-2 text-sm font-semibold text-navy-950 hover:bg-sky-400"
              >
                ⚽ Sync FanTeam to Hail Mary
              </BookmarkletLink>
              <p className="mt-3 text-xs text-navy-500">
                No bookmarks bar visible? Most browsers show it with Ctrl+Shift+B (Windows) or ⌘+Shift+B (Mac). On
                phones, some browsers let you add a bookmarklet by editing an existing bookmark&apos;s address.
              </p>
            </div>

            <div className="mt-4 rounded-xl border border-navy-700 bg-navy-900 p-6">
              <p className="text-xs font-semibold uppercase tracking-wide text-navy-400">Step 2</p>
              <p className="mt-1 text-sm text-navy-200">
                Go to <span className="text-white">fanteam.com</span> and log in normally, like you always do.
              </p>
            </div>

            <div className="mt-4 rounded-xl border border-navy-700 bg-navy-900 p-6">
              <p className="text-xs font-semibold uppercase tracking-wide text-navy-400">Step 3</p>
              <p className="mt-1 text-sm text-navy-200">
                While still on that FanTeam tab, click the <span className="text-white">Sync FanTeam to Hail Mary</span>{" "}
                bookmark. You&apos;ll see a confirmation pop-up if it worked.
              </p>
            </div>

            <div className="mt-6 rounded-xl border border-amber-900 bg-amber-950/30 p-4">
              <p className="text-xs text-amber-300">
                This only lasts about 3 hours (FanTeam&apos;s own token lifetime) - repeat these steps whenever you
                want fresh data. Check your{" "}
                <Link href="/fanteam" className="underline hover:text-amber-200">
                  FanTeam squad page
                </Link>{" "}
                afterward - the sync badge turns green once a scheduled run has picked the token up (within ~20
                minutes).
              </p>
            </div>
          </>
        )}
      </main>
    </div>
  );
}
