"""Character sets and word mutations used by the search engines."""

from __future__ import annotations

import itertools
import string
from pathlib import Path

from ..fs import read_text
from ..errors import UsageError

__all__ = [
    "NAMED_CHARSETS",
    "resolve_charset",
    "charset_from_file",
    "load_words",
    "build_word_variants",
    "LEET_MAP",
]

LEET_MAP = {
    "a": "4@",
    "b": "8",
    "e": "3",
    "g": "96",
    "i": "1!",
    "l": "1|",
    "o": "0",
    "s": "5$",
    "t": "7",
    "z": "2",
}

NAMED_CHARSETS: dict[str, str] = {
    "alpha": string.ascii_letters,
    "lower": string.ascii_lowercase,
    "upper": string.ascii_uppercase,
    "digits": string.digits,
    "alnum": string.ascii_letters + string.digits,
    "alphanumeric": string.ascii_letters + string.digits,
    "lowernum": string.ascii_lowercase + string.digits,
    "symbols": "!\"#$%&'()*+,-./:;<=>?@[\\]^_`{|}~",
    "punct": string.punctuation,
    "printable": string.printable[:95],
    "all": string.ascii_letters + string.digits + string.punctuation,
    "hex": "0123456789abcdef",
    "hexupper": "0123456789ABCDEF",
    "base58": "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz",
    "base16": "0123456789abcdef",
    "armory": "asdfghjkwertuion",
    "space": " ",
}


def resolve_charset(spec: str) -> str:
    """Turn a charset name (``alnum``, ``hex``, ...) or literal into characters."""
    if not spec:
        raise UsageError("empty character set")
    key = spec.strip().lower()
    if key in NAMED_CHARSETS:
        return NAMED_CHARSETS[key]
    if spec.startswith("file:"):
        return charset_from_file(spec[5:])
    # Allow "lower+digits" style combinations of names.
    if all(part in NAMED_CHARSETS or part == "" for part in key.replace(" ", "").split("+")):
        combined = ""
        for part in key.replace(" ", "").split("+"):
            if part:
                combined += NAMED_CHARSETS[part]
        return "".join(dict.fromkeys(combined))
    deduped = "".join(dict.fromkeys(spec))
    if not deduped:
        raise UsageError(f"character set {spec!r} is empty")
    return deduped


def charset_from_file(path: str) -> str:
    """Read a character set from a file (all whitespace stripped, order kept)."""
    text = read_text(path, "character set file")
    chars = "".join(dict.fromkeys(ch for ch in text if not ch.isspace()))
    if not chars:
        raise UsageError(f"character set file {path} contains no characters")
    return chars


def load_words(source: str | Path) -> list[str]:
    """Load a word list from a file or a comma separated string."""
    if isinstance(source, Path) or (isinstance(source, str) and Path(source).exists()):
        words = [w.strip() for w in read_text(source, "word file").splitlines()]
    else:
        text = str(source).replace("\n", ",")
        words = [w.strip() for w in text.split(",")]
    words = [w for w in words if w]
    if not words:
        raise UsageError(f"no words found in {source!r}")
    return list(dict.fromkeys(words))


def _leet_variants(word: str, max_variants: int = 64) -> list[str]:
    options = []
    for ch in word.lower():
        choices = [ch] + list(LEET_MAP.get(ch, ""))
        options.append(choices)
    out = []
    for combo in itertools.product(*options):
        out.append("".join(combo))
        if len(out) >= max_variants:
            break
    return out


def _case_variants(word: str) -> list[str]:
    return [
        word,
        word.lower(),
        word.upper(),
        word.capitalize(),
        word[:1].upper() + word[1:],
    ]


def build_word_variants(
    words: list[str],
    leet: bool = False,
    case: bool = True,
    suffixes: tuple[str, ...] = (),
    max_variants_per_word: int = 64,
) -> list[str]:
    """Expand dictionary words the way a user's passphrase is usually mangled."""
    out: list[str] = []
    for word in words:
        base = _case_variants(word) if case else [word]
        expanded: list[str] = []
        for item in base:
            expanded.append(item)
            if leet:
                expanded.extend(_leet_variants(item, max_variants_per_word))
        for item in dict.fromkeys(expanded):
            out.append(item)
            for suffix in suffixes:
                out.append(item + suffix)
    return list(dict.fromkeys(out))
