"""
run_migration.py
-----------------
Runs every .sql file in supabase/migrations/ (in filename order) against
the database at DATABASE_URL (read from .env), skipping any that are
already recorded as applied in the schema_migrations table. Safe to run
repeatedly as new migration files get added.

RUN:
    python3 scripts/run_migration.py
"""

import os
import sys
from pathlib import Path

import psycopg2

ROOT = Path(__file__).resolve().parent.parent


def load_env():
    env_path = ROOT / ".env"
    for line in env_path.read_text().splitlines():
        line = line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, _, value = line.partition("=")
        os.environ.setdefault(key.strip(), value.strip())


def main():
    load_env()
    db_url = os.environ.get("DATABASE_URL")
    if not db_url:
        raise SystemExit("DATABASE_URL not set in .env")

    migrations_dir = ROOT / "supabase" / "migrations"
    sql_files = sorted(migrations_dir.glob("*.sql"))
    if not sql_files:
        raise SystemExit(f"No .sql files found in {migrations_dir}")

    conn = psycopg2.connect(db_url)
    conn.autocommit = False
    try:
        with conn.cursor() as cur:
            cur.execute(
                """
                create table if not exists schema_migrations (
                    filename text primary key,
                    applied_at timestamptz not null default now()
                )
                """
            )
            cur.execute("select filename from schema_migrations")
            already_applied = {row[0] for row in cur.fetchall()}

            for path in sql_files:
                if path.name in already_applied:
                    print(f"Skipping {path.name} (already applied)")
                    continue
                print(f"Applying {path.name} ...")
                cur.execute(path.read_text())
                cur.execute("insert into schema_migrations (filename) values (%s)", (path.name,))
        conn.commit()
        print("All migrations applied successfully.")
    except Exception:
        conn.rollback()
        raise
    finally:
        conn.close()


if __name__ == "__main__":
    main()
