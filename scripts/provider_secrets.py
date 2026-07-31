"""
provider_secrets.py
--------------------
Encrypts/decrypts every provider credential (tokens, session state, a
last-resort password) before it ever touches provider_credentials
(migration 0071) - that table stores ciphertext only. Symmetric,
authenticated encryption (Fernet: AES-128-CBC + HMAC) with a single key
read from PROVIDER_SECRETS_KEY - present in .env locally (gitignored) and
as a GitHub Actions secret for the scheduled sync jobs, never committed,
never sent to the frontend (the Next.js/Vercel runtime never imports this
module or holds this key - see provider_squad_links' RLS comment in the
migration for why).

Not a standalone script - imported by every provider_*.py sync module.
"""
import os

from cryptography.fernet import Fernet


def _fernet():
    key = os.environ.get("PROVIDER_SECRETS_KEY")
    if not key:
        raise SystemExit(
            "PROVIDER_SECRETS_KEY not set - generate one with "
            "`python3 -c \"from cryptography.fernet import Fernet; print(Fernet.generate_key().decode())\"` "
            "and add it to .env (local) and as a GitHub Actions secret (scheduled sync)."
        )
    return Fernet(key.encode())


def encrypt(value):
    """str | None -> str | None. Idempotent on None so callers can encrypt
    optional fields (e.g. a provider with no password fallback) without a
    None-check at every call site."""
    if value is None:
        return None
    return _fernet().encrypt(value.encode()).decode()


def decrypt(value):
    if value is None:
        return None
    return _fernet().decrypt(value.encode()).decode()
