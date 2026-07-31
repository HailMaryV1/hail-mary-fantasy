"""
name_matching.py
-------------------
Shared surname-matching helpers for every player importer/matcher
(import_fanteam_live.py, import_cloudff.py, sync_provider_squads.py).
Previously duplicated three times, slightly differently, in each of
those files - exactly the kind of drift that let this bug slip through
one copy at a time.

compact() used to strip any non-ASCII character outright instead of
transliterating it to its base Latin letter - confirmed live as the
root cause of ~20 real split player identities (Hugo Ekitiké/Ekitike,
Martin Ødegaard/Odegaard, Saša Lukić/Sasa Lukic, ...): stripping "é"
from "Ekitiké" leaves "ekitik" (six letters), one short of the
canonical "Ekitike" row's own surname_key "ekitike" - a silent
one-character mismatch that made every provider payload using a
correctly-accented name create a brand new player row instead of
matching the existing one. See merge_player_identities.py for the
one-time cleanup of identities this already split before the fix.

RUN: not a script - imported by the files above.
"""
import re
import unicodedata

# Letters with no NFKD decomposition into base-letter + combining-accent
# (so unicodedata.normalize alone won't transliterate them) - real cases
# confirmed live in this project's own player data (Martin Ødegaard).
_MANUAL_TRANSLITERATIONS = str.maketrans({
    "ø": "o", "Ø": "O",
    "æ": "ae", "Æ": "AE",
    "œ": "oe", "Œ": "OE",
    "đ": "d", "Đ": "D",
    "ł": "l", "Ł": "L",
    "þ": "th", "Þ": "Th",
    "ß": "ss",
})


def transliterate(name: str) -> str:
    """Best-effort ASCII transliteration - accented Latin letters (é, í,
    š, ć, ...) collapse to their base letter via Unicode NFKD
    decomposition; the handful of letters with no such decomposition
    (ø, æ, ...) go through an explicit table first."""
    name = name.translate(_MANUAL_TRANSLITERATIONS)
    normalized = unicodedata.normalize("NFKD", name)
    return normalized.encode("ascii", "ignore").decode("ascii")


def compact(name: str) -> str:
    return re.sub(r"[^a-z]", "", transliterate(name).lower())


def surname_key(full_name: str) -> str:
    """Everything after the first word, not just the last one - a naive
    last-word-only key breaks for compound/multi-word surnames (e.g.
    "Jocelin Ta Bi"'s real surname is "Ta Bi", not just "Bi" - see
    import_fanteam_live.py's original docstring for the real Ta Bi/
    Manzambi collision this avoids). The "Firstname. Surname" form
    (e.g. "E. Haaland") is handled explicitly since compact() alone
    would fold the leading initial into the surname key otherwise."""
    if ". " in full_name:
        return compact(full_name.split(". ", 1)[1])
    parts = full_name.split(" ")
    return compact(" ".join(parts[1:])) if len(parts) > 1 else compact(full_name)
