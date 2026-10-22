"""Matching a sender against the closed list in senders.yaml.

A sender is recognised by its *distinctive* words: "בית החולים", "מחלקת פנימית ב'" and the like say nothing about who
the sender is, so they are ignored. "מחלקת פנימית ב' לניאדו" and "לניאדו - מרכז רפואי צאנז" share the word "לניאדו",
which is what makes the former a department of the latter. A value whose distinctive words are not all found in one
sender never matches (a loose whole-string similarity maps "סנט מרי" onto "סנט ג'וזף").
"""
import re
from typing import Any, Dict, List, Optional, Tuple

from rapidfuzz import fuzz


def _norm(s: str) -> str:
    s = s.lower()
    s = re.sub(r"[\"'״׳`.,\-()]", "", s)
    return re.sub(r"\s+", " ", s).strip()


normalize_for_match = _norm  # the form in which two spellings of a sender count as the same

# Words that do not tell one sender from another: institution kinds, departments and their designators.
GENERIC_WORDS = frozenset({
    "בית", "בתי", "חולים", "מרכז", "רפואי", "רפואית", "קריה", "קמפוס", "עש", "על", "שם", "של",
    "מחלקת", "מחלקה", "מחלקות", "יחידת", "יחידה", "מרפאת", "מרפאה", "מרפאות", "מכון", "מכוני", "אגף", "מערך",
    "פנימית", "פנימי", "ילדים", "יולדות", "נשים", "כירורגית", "כירורגי", "אורתופדית", "אורתופדי", "מיון",
    "טיפול", "נמרץ", "שיקום", "גריאטריה", "אונקולוגית", "המטולוגית", "קרדיולוגית", "נוירולוגית", "עיניים",
    "קופת", "קופה", "שירותי", "בריאות", "גינקולוגית", "זיהומיות", "מחלות", "וירולוגיה", "מיקרוביולוגיה", "מעבדה", "מעבדת",
    "hospital", "medical", "center", "centre", "department", "dept", "clinic", "ward", "internal", "the",
})
# A value that starts with one of these is a department *of* some institution. (A clinic or institute may well be a
# sender of its own, so those are not stripped.)
DEPARTMENT_MARKERS = frozenset({"מחלקת", "מחלקה", "מחלקות", "יחידת", "יחידה", "אגף", "מערך", "department", "dept", "ward"})
TOKEN_FUZZ = 88  # two single words are the same word (a typo apart) from this similarity


def _is_generic(token: str) -> bool:
    return token in GENERIC_WORDS or (token.startswith("ה") and token[1:] in GENERIC_WORDS)


def distinctive(value: str) -> List[str]:
    """The words of `value` that identify a sender (no institution kinds, department names, one-letter designators)."""
    return [t for t in _norm(value).split() if len(t) > 1 and not _is_generic(t)]


def strip_department(value: str) -> str:
    """"מחלקת פנימית ב' X" -> "X": the institution a department belongs to. Other values are returned unchanged."""
    words = value.split()
    if not words or _norm(words[0]) not in DEPARTMENT_MARKERS:
        return value
    i = 1
    while i < len(words) and (len(_norm(words[i])) <= 1 or _is_generic(_norm(words[i]))):
        i += 1
    rest = " ".join(words[i:]).strip()
    return rest if distinctive(rest) else value


def canonical_names(cfg: Dict[str, Any]) -> List[str]:
    return [s["name"] for s in cfg.get("senders", [])]


def _same_word(a: str, b: str) -> Optional[bool]:
    """True: identical, False: a typo apart, None: different words."""
    if a == b:
        return True
    if len(a) >= 4 and len(b) >= 4 and fuzz.ratio(a, b) >= TOKEN_FUZZ:
        return False
    return None


def _cover(value_words: List[str], cand_words: List[str]) -> Tuple[int, bool]:
    """How many of the value's words appear in the candidate, and whether all of those were spelled identically."""
    found, identical = 0, True
    for w in value_words:
        best: Optional[bool] = None
        for c in cand_words:
            same = _same_word(w, c)
            if same is True:
                best = True
                break
            if same is False:
                best = False
        if best is not None:
            found += 1
            identical = identical and best
    return found, identical


def resolve_sender(value: str, cfg: Dict[str, Any]) -> Tuple[Optional[str], float, str]:
    """(canonical name or None, score 0-100, how).  how: "exact" | "words" | "fuzzy" | "none".

    exact: the value equals a name / alias after normalization.
    words: every distinctive word of the value is a word of one sender ("מחלקת פנימית ב' לניאדו").
    fuzzy: the same, but with a misspelt word, or the distinctive words are very similar as a whole.
    A value that fits several senders equally well (just "הדסה", just "אסותא") is ambiguous: no match.
    """
    if not value:
        return None, 0.0, "none"
    v = _norm(value)
    senders = cfg.get("senders", [])
    for s in senders:
        if any(v == _norm(c) for c in [s["name"], *s.get("aliases", [])]):
            return s["name"], 100.0, "exact"

    words = distinctive(value)
    if not words or sum(len(w) for w in words) < 3:
        return None, 0.0, "none"
    joined = " ".join(sorted(words))

    covering: Dict[str, Tuple[bool, float]] = {}  # sender -> (spelled identically, share of its words the value covers)
    best_whole = (None, 0.0)
    for s in senders:
        for cand in [s["name"], *s.get("aliases", [])]:
            cw = distinctive(cand)
            if not cw:
                continue
            found, identical = _cover(words, cw)
            if found == len(words):
                key = (identical, found / len(cw))
                if key > covering.get(s["name"], (False, -1.0)):
                    covering[s["name"]] = key
            whole = fuzz.ratio(joined, " ".join(sorted(cw)))
            if whole > best_whole[1]:
                best_whole = (s["name"], whole)

    if covering:
        ranked = sorted(covering.items(), key=lambda kv: kv[1], reverse=True)
        if len(ranked) == 1 or ranked[0][1] > ranked[1][1]:
            name, (identical, _share) = ranked[0]
            return name, (90.0 if identical else 85.0), ("words" if identical else "fuzzy")
        return None, 0.0, "none"  # fits several senders equally: ambiguous
    if best_whole[0] and best_whole[1] >= cfg.get("match_threshold", 85):
        return best_whole[0], best_whole[1], "fuzzy"
    return None, best_whole[1], "none"


def match_sender(value: str, cfg: Dict[str, Any]) -> Tuple[Optional[str], float, bool]:
    """Return (canonical name or None, score 0-100, exact). exact=True when the value equals a name / alias."""
    name, score, how = resolve_sender(value, cfg)
    return name, score, how == "exact"


def is_canonical(value: str, cfg: Dict[str, Any]) -> bool:
    return value in canonical_names(cfg)


def add_sender(cfg: Dict[str, Any], name: str) -> bool:
    """Make `name` known: a new sender, or a new spelling (alias) of the one it resolves to. False: already known."""
    name = " ".join(name.split())
    if not name:
        return False
    found, _score, how = resolve_sender(name, cfg)
    if how == "exact":
        return False
    if found is not None:
        entry = next(s for s in cfg["senders"] if s["name"] == found)
        entry.setdefault("aliases", []).append(name)
        return True
    cfg.setdefault("senders", []).append({"name": name, "aliases": []})
    return True


def merge_defaults(cfg: Dict[str, Any], defaults: Dict[str, Any]) -> bool:
    """Add the default senders a stored list lacks; returns whether cfg changed.

    A default whose name is an alias of a stored sender (e.g. the old short name "שיבא") is not added again:
    the stored entry keeps its canonical name and learns the default's full name as an alias.
    """
    stored = cfg.setdefault("senders", [])
    changed = False
    for d in defaults.get("senders", []):
        known = {_norm(s["name"]): s for s in stored}
        if _norm(d["name"]) in known:
            continue
        old = next((known[_norm(a)] for a in d.get("aliases", []) if _norm(a) in known), None)
        if old is not None:
            old.setdefault("aliases", []).append(d["name"])
        else:
            stored.append({"name": d["name"], "aliases": list(d.get("aliases", []))})
        changed = True
    return changed
