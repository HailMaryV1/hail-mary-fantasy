"""
bootstrap_provider_credentials.py
-----------------------------------
One-time (or re-run-when-a-password-changes) setup for Auto Import My
Squad. Run this yourself, locally - it prompts for your real provider
login via getpass (never echoed to the terminal, never logged, never
sent anywhere except the provider's own real login endpoint to verify it
works), encrypts it with provider_secrets.py (PROVIDER_SECRETS_KEY, see
.env), and stores only the ciphertext in provider_credentials (migration
0071 - RLS-locked to service-role access only, no frontend path ever
reads this table).

This is the auth_method = 'encrypted_password' tier specifically for
FanTeam (see provider_fanteam_scoutgg.py's module docstring for why - no
confirmed silent-refresh endpoint exists there, so a fresh login happens
on every sync run instead). Not needed for a provider that has a real
refresh-token flow - that tier stores the refresh token instead and never
touches this script's password path.

RUN:
    python3 scripts/bootstrap_provider_credentials.py fanteam_scoutgg
"""
import getpass
import os
import sys
from pathlib import Path

import psycopg2
import psycopg2.extras

sys.path.insert(0, str(Path(__file__).resolve().parent))
import provider_secrets

ROOT = Path(__file__).resolve().parent.parent


def load_env():
    env_path = ROOT / ".env"
    for line in env_path.read_text().splitlines():
        line = line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, _, value = line.partition("=")
        os.environ.setdefault(key.strip(), value.strip())


def get_sole_user(cur):
    cur.execute("select id, email from auth.users")
    rows = cur.fetchall()
    if len(rows) != 1:
        raise SystemExit(
            f"Expected exactly one auth.users row for this single-user app, found {len(rows)} - "
            "pass the intended user_id explicitly if that's changed."
        )
    return rows[0]


def bootstrap_fanteam(cur, user_id):
    import provider_fanteam_scoutgg as fanteam

    print("FanTeam (covers FanTeam Football, Golf and NFL - one Scout Gaming account).")
    email = input("FanTeam email: ").strip()
    password = getpass.getpass("FanTeam password (not shown): ")

    print("Verifying against the real login endpoint ...")
    access_token, refresh_token, profile = fanteam.login(email, password)
    print(f"  Logged in as {profile.get('username') if profile else '(unknown)'} - credentials are real and working.")

    cur.execute(
        """
        insert into provider_credentials (user_id, provider, auth_method, encrypted_username, encrypted_password, last_refreshed_at)
        values (%s, 'fanteam_scoutgg', 'encrypted_password', %s, %s, now())
        on conflict (user_id, provider) do update set
          auth_method = excluded.auth_method,
          encrypted_username = excluded.encrypted_username,
          encrypted_password = excluded.encrypted_password,
          last_refreshed_at = now(),
          last_refresh_error = null,
          updated_at = now()
        """,
        (user_id, provider_secrets.encrypt(email), provider_secrets.encrypt(password)),
    )
    print("Stored (encrypted) - run scripts/sync_provider_squads.py --provider fanteam_scoutgg to import your real squads.")


BOOTSTRAPPERS = {
    "fanteam_scoutgg": bootstrap_fanteam,
}


def main():
    if len(sys.argv) != 2 or sys.argv[1] not in BOOTSTRAPPERS:
        raise SystemExit(f"Usage: python3 scripts/bootstrap_provider_credentials.py <{'|'.join(BOOTSTRAPPERS)}>")
    provider = sys.argv[1]

    load_env()
    conn = psycopg2.connect(os.environ["DATABASE_URL"])
    cur = conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor)
    try:
        user = get_sole_user(cur)
        BOOTSTRAPPERS[provider](cur, user["id"])
        conn.commit()
    except Exception:
        conn.rollback()
        raise
    finally:
        cur.close()
        conn.close()


if __name__ == "__main__":
    main()
