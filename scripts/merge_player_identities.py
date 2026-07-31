"""
merge_player_identities.py
------------------------------
Controlled merge for confirmed duplicate players.id rows found by
audit_player_identities.py (re-run AFTER name_matching.py's Unicode
transliteration fix - see that module's docstring for the root cause:
compact() used to strip accented characters outright instead of
transliterating them to their base Latin letter, so e.g. "Hugo Ekitiké"
never matched the existing canonical "Hugo Ekitike" row and got
imported as a brand new player every time).

Dry-run by default - prints exactly what would change; only writes with
--apply. Split into two phases, run and committed separately:

  --phase 1 : objective Unicode/exact duplicates. Every pair here is
    confirmed two ways: (a) audit_player_identities.py's real detection
    rule - the EXACT SAME live_compact.endswith(surname_key(name)) rule
    import_fanteam_live.py's own candidate search uses, not a looser
    approximation - and (b) the two names are IDENTICAL once
    transliterated (same words, only diacritics/punctuation differ).
    No name-relationship judgment call involved - re-running the live
    FanTeam import after the fix (confirmed live, 2026-07-31) flags every
    one of these as [ambiguous] rather than creating a new duplicate,
    which is exactly what proves the fix actually stops recurrence.

  --phase 2 : reviewed nickname/full-name merges. Same detection rule,
    but the two names differ by more than encoding - a mononym vs full
    name, a dropped middle name, a shortened surname (e.g. "Jamie
    Bynoe-Gittens" vs "Jamie Gittens"). Still real - each pair's
    canonical/duplicate share a dreamteam or cloudff external_id
    confirming the same underlying identity - but a human judgment call
    in a way Phase 1 isn't, so kept and reviewed separately.

Explicitly investigated and EXCLUDED this round - real, different
people who happen to share a surname/substring, each confirmed by
having their OWN independent dreamteam/cloudff/NFL external_id (a
provider would never issue two different real IDs to one real person):
  Hugo Bueno / Santiago Bueno, Tyler Fletcher / Jack Fletcher,
  Rodrigo Gomes / Angel Gomes, Tez Johnson / Kameron Johnson,
  D. Moller Wolfe / David Wolfe (weak/uncertain signal either way).

Genuinely uncertain - NOT merged, needs a human's real-world
confirmation, not inference:
  Degnand Gnonto (id=224) / Wilfried Gnonto (id=1273) - the first names
  share no real relationship, despite matching team/position.

Explicitly NOT in scope this round - a DIFFERENT bug, not the Unicode
one: mononym-vs-full-name display (e.g. "Kepa" / "Kepa Arrizabalaga",
"Jair" / "Jair Cunha", "A. Becker" / "Becker Alisson", "K. JiSoo" /
"Ji-soo Kim", "Reinildo" / "Reinildo Mandava") - confirmed these do NOT
satisfy audit_player_identities.py's real matching rule at all (a bare
mononym's surname_key never matches a full name's own surname_key), so
the Unicode fix has no bearing on them - worth a dedicated follow-up,
not bundled into this fix.

RUN:
    python3 scripts/merge_player_identities.py --phase 1            # dry run
    python3 scripts/merge_player_identities.py --phase 1 --apply
    python3 scripts/merge_player_identities.py --phase 2
    python3 scripts/merge_player_identities.py --phase 2 --apply
"""
import argparse
import io
import os
import sys
from pathlib import Path

import psycopg2
import psycopg2.extras

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "scripts"))
from activity_log import log_event  # noqa: E402

# Real player names legitimately contain non-ASCII characters (that's
# the whole point of this script) - Windows' console codepage can't
# print those directly.
sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding="utf-8", errors="replace")

# (canonical_id, duplicate_id, reason) - canonical is always the row
# with a real dreamteam and/or cloudff anchor; duplicate is the row with
# only a FanTeam link (FanTeam's 2026/27 re-registration issued a new
# external_id under the correctly-spelled/full real name, splitting off
# from the canonical row - see module docstring).
PHASE1_PAIRS = [
    (37, 765, "Ethan Ampadu - exact duplicate, newer row is a stale 'merged-1248' placeholder"),
    (92, 729, "Evann Guessand - exact duplicate, newer row is a stale 'merged-1203' placeholder"),
    (442, 724, "Lamare Bogarde - exact duplicate, newer row is a stale 'merged-1198' placeholder"),
    (50, 737, "Mats Wieffer - exact duplicate, newer row is a stale 'merged-1212' placeholder"),
    (14, 712, "Antonin Kinsky / Antonín Kinský"),
    (228, 726, "Emiliano Buendia / Emiliano Buendía"),
    (24, 694, "Hugo Ekitike / Hugo Ekitiké"),
    (46, 740, "Diego Gomez / Diego Gómez"),
    (62, 755, "Bafode Diakite / Bafodé Diakité"),
    (74, 676, "Martin Odegaard / Martin Ødegaard"),
    (75, 678, "Christian Norgaard / Christian Nørgaard"),
    (88, 762, "Enes Unal / Enes Ünal"),
    (95, 684, "Marc Guehi / Marc Guéhi"),
    (107, 731, "Bruno Guimaraes / Bruno Guimarães"),
    (116, 772, "Nikola Milenkovic / Nikola Milenković"),
    (147, 696, "Lisandro Martinez / Lisandro Martínez"),
    (151, 695, "Diego Leon / Diego León"),
    (157, 787, "Walter Benitez / Walter Benítez"),
    (169, 786, "Daniel Munoz / Daniel Muñoz"),
    (195, 791, "Enzo Le Fee / Enzo Le Fée"),
    (204, 708, "Enzo Fernandez / Enzo Fernández"),
    (359, 735, "Fabian Schar / Fabian Schär"),
    (261, 683, "Nico Gonzalez / Nico González"),
    (278, 773, "Ibrahim Sangare / Ibrahim Sangaré"),
    (279, 776, "Nicolas Dominguez / Nicolás Domínguez"),
    (284, 702, "Robert Sanchez / Robert Sánchez"),
    (285, 701, "Filip Jorgensen / Filip Jørgensen"),
    (303, 769, "Merlin Rohl / Merlin Röhl"),
    (308, 674, "Piero Hincapie / Piero Hincapié"),
    (364, 679, "Viktor Gyokeres / Viktor Gyökeres"),
    (410, 781, "Sasa Lukic / Saša Lukić"),
    (427, 720, "Emiliano Martinez / Emiliano Martínez"),
    (443, 723, "Victor Lindelof / Victor Lindelöf"),
    (445, 727, "Andres Garcia / Andrés García"),
    (209, 877, "Estevao / Estêvão"),
    (99, 1280, "Rayan Ait Nouri / Rayan Aït-Nouri"),
]

PHASE2_PAIRS = [
    (86, 1282, "Eli Junior Kroupi / Eli Kroupi - dropped middle name"),
    (489, 623, "J. Strand Larsen / Jorgen Larsen - initial-form vs given name, lower-confidence (stray fanteam link uses an older, non-2026/27-pattern external_id)"),
    (277, 777, "Omari Giraud-Hutchinson / Omari Hutchinson - shortened surname"),
    (211, 707, "Jamie Bynoe-Gittens / Jamie Gittens - shortened surname"),
    (358, 1272, "Valentino Livramento / Tino Livramento - nickname"),
    (590, 784, "C. Doucoure / Cheick Doucouré - initial-form vs full given name + accent"),
    (591, 782, "M. Franca / Matheus França - initial-form vs full given name + accent"),
    (436, 1281, "Hakon Rafn Valdimarsson / Hákon Valdimarsson - dropped middle name + accent"),
    # Axel Toth (id=395) / Alex Tóth (id=756) - deliberately excluded from
    # this pass per explicit direction: the official identity is "Alex
    # Tóth", so "Axel Toth" is itself the wrong record (a source-data
    # error, not a nickname/display variant) - a merge would keep the
    # WRONG name as canonical. Needs its own investigation (which import
    # first introduced "Axel Toth", and everywhere it's referenced)
    # before this gets touched at all.
]


def load_env():
    env_path = ROOT / ".env"
    if not env_path.exists():
        return
    for line in env_path.read_text().splitlines():
        line = line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, _, value = line.partition("=")
        os.environ.setdefault(key.strip(), value.strip())


def find_fk_columns(cur, foreign_table):
    cur.execute(
        """
        select tc.table_name, kcu.column_name
        from information_schema.table_constraints tc
        join information_schema.key_column_usage kcu on kcu.constraint_name = tc.constraint_name
        join information_schema.constraint_column_usage ccu on ccu.constraint_name = tc.constraint_name
        where tc.constraint_type = 'FOREIGN KEY' and ccu.table_name = %s
        """,
        (foreign_table,),
    )
    return [(r["table_name"], r["column_name"]) for r in cur.fetchall()]


def merge_pair(cur, canonical_id, duplicate_id, reason, game_player_fks, player_fks, apply_changes, log):
    cur.execute("select full_name from players where id = %s", (canonical_id,))
    canonical_row = cur.fetchone()
    cur.execute("select full_name from players where id = %s", (duplicate_id,))
    duplicate_row = cur.fetchone()
    if not canonical_row or not duplicate_row:
        log(f"  [SKIP] {reason}: canonical={canonical_id} or duplicate={duplicate_id} no longer exists (already merged?)")
        return

    log(f"\n{reason}")
    log(f"  canonical: id={canonical_id} ({canonical_row['full_name']})")
    log(f"  duplicate: id={duplicate_id} ({duplicate_row['full_name']})")

    cur.execute("select id, game_id, external_id, is_active from game_players where player_id = %s", (duplicate_id,))
    dup_game_players = cur.fetchall()

    for dgp in dup_game_players:
        cur.execute("select slug from fantasy_games where id = %s", (dgp["game_id"],))
        slug = cur.fetchone()["slug"]

        if dgp["external_id"].startswith("merged-"):
            log(f"  [DELETE] game_players.id={dgp['id']} (game={slug}, synthetic placeholder {dgp['external_id']!r}) + its downstream rows")
            for table, column in game_player_fks:
                cur.execute(f'select count(*) as n from "{table}" where "{column}" = %s', (dgp["id"],))
                n = cur.fetchone()["n"]
                if n:
                    log(f"    delete {n} row(s) from {table}.{column}")
                    if apply_changes:
                        cur.execute(f'delete from "{table}" where "{column}" = %s', (dgp["id"],))
            if apply_changes:
                cur.execute("delete from game_players where id = %s", (dgp["id"],))
        else:
            log(f"  [REPOINT] game_players.id={dgp['id']} (game={slug}, external_id={dgp['external_id']!r}) player_id {duplicate_id} -> {canonical_id}")
            if apply_changes:
                cur.execute("update game_players set player_id = %s, updated_at = now() where id = %s", (canonical_id, dgp["id"]))

    for table, column in player_fks:
        cur.execute(f'select count(*) as n from "{table}" where "{column}" = %s', (duplicate_id,))
        n = cur.fetchone()["n"]
        if n:
            log(f"  [REPOINT] {table}.{column}: {n} row(s) {duplicate_id} -> {canonical_id}")
            if apply_changes:
                cur.execute(f'update "{table}" set "{column}" = %s where "{column}" = %s', (canonical_id, duplicate_id))

    log(f"  [DELETE] players.id={duplicate_id}")
    if apply_changes:
        cur.execute("delete from players where id = %s", (duplicate_id,))
        log_event(
            cur, "player_identity_merged", f"Merged duplicate player {duplicate_row['full_name']!r} into {canonical_row['full_name']!r}",
            details={"canonical_id": canonical_id, "duplicate_id": duplicate_id, "reason": reason},
        )


def consolidate_post_merge_collisions(cur, pairs, apply_changes, log):
    """After merging, a canonical player can end up with 2+ game_players
    rows for the SAME game (its own pre-existing row, plus the newly-
    repointed one) - see module docstring. Deactivates the older of the
    two so exactly one is ever "the" live match; never deletes."""
    log("\n--- Post-merge same-game collisions ---")
    cur.execute(
        """
        select player_id, game_id, array_agg(id order by id) as ids
        from game_players
        where player_id in %s
        group by player_id, game_id
        having count(*) > 1
        """,
        (tuple(pair[0] for pair in pairs) or (0,),),
    )
    collisions = cur.fetchall()
    if not collisions:
        log("None.")
    for c in collisions:
        older_id = c["ids"][0]
        cur.execute("select is_active, external_id from game_players where id = %s", (older_id,))
        row = cur.fetchone()
        if not row["is_active"]:
            log(f"  player_id={c['player_id']} game_id={c['game_id']}: ids={c['ids']} - older row {older_id} already inactive, nothing to do")
            continue
        log(f"  player_id={c['player_id']} game_id={c['game_id']}: ids={c['ids']} - deactivating older row {older_id} (external_id={row['external_id']!r})")
        if apply_changes:
            cur.execute("update game_players set is_active = false, updated_at = now() where id = %s", (older_id,))


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--phase", type=int, choices=[1, 2], required=True)
    parser.add_argument("--apply", action="store_true")
    args = parser.parse_args()
    pairs = PHASE1_PAIRS if args.phase == 1 else PHASE2_PAIRS

    load_env()
    conn = psycopg2.connect(os.environ["DATABASE_URL"])
    conn.autocommit = False
    cur = conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor)

    def log(msg):
        print(msg)

    try:
        game_player_fks = find_fk_columns(cur, "game_players")
        player_fks = [(t, c) for t, c in find_fk_columns(cur, "players") if t != "game_players"]

        log(f"{'APPLYING' if args.apply else 'DRY RUN'} - PHASE {args.phase} - {len(pairs)} pairs")
        for canonical_id, duplicate_id, reason in pairs:
            merge_pair(cur, canonical_id, duplicate_id, reason, game_player_fks, player_fks, args.apply, log)

        consolidate_post_merge_collisions(cur, pairs, args.apply, log)

        if args.apply:
            conn.commit()
            log("\nCommitted.")
        else:
            conn.rollback()
            log("\nDry run only - nothing written. Re-run with --apply to execute.")
    except Exception:
        conn.rollback()
        raise
    finally:
        cur.close()
        conn.close()


if __name__ == "__main__":
    main()
