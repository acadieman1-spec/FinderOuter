"""Helpers shared by the recovery engines."""

from __future__ import annotations

import argparse
from pathlib import Path

from ..fs import read_text
from ..compare import Target, target_from_string
from ..crypto.addresses import all_addresses, p2pkh
from ..crypto.secp256k1 import pubkey_from_privkey
from ..crypto.wif import encode_wif
from ..errors import UsageError
from ..search.charsets import build_word_variants, load_words, resolve_charset
from ..search.space import CompositeSpace, SearchSpace, Slot

__all__ = [
    "add_common_target_args",
    "add_passphrase_args",
    "build_target",
    "build_passphrase_space",
    "ownership_acknowledged",
    "key_report",
    "combine_lengths",
]

OWNERSHIP_FLAGS = ("i_own_this", "force")


def add_common_target_args(parser: argparse.ArgumentParser) -> None:
    group = parser.add_argument_group("comparison target")
    group.add_argument(
        "--target",
        metavar="VALUE",
        help="address, public key, WIF/hex private key or HASH160 to check candidates against",
    )
    group.add_argument(
        "--target-type",
        choices=("auto", "address", "pubkey", "privkey", "hash160"),
        default="auto",
        help="force the interpretation of --target (default: auto detect)",
    )


def add_passphrase_args(parser: argparse.ArgumentParser, what: str = "passphrase") -> None:
    group = parser.add_argument_group(what)
    group.add_argument("--charset", metavar="SET", help="characters to try (name like 'alnum', 'a-z0-9' or literal)")
    group.add_argument(
        "--length",
        metavar="N|MIN..MAX",
        help=f"length of the {what} (single value or a range such as 4..8)",
    )
    group.add_argument(
        "--words",
        metavar="LIST|FILE",
        help="dictionary mode: comma separated words or a file with one word per line",
    )
    group.add_argument("--leet", action="store_true", help="also try common leetspeak substitutions")
    group.add_argument(
        "--no-case",
        action="store_true",
        help="do not add upper/lower/capitalised variants of dictionary words",
    )
    group.add_argument(
        "--suffix",
        metavar="LIST",
        help="append these strings to each dictionary word (comma separated)",
    )
    group.add_argument(
        "--prefix",
        metavar="LIST",
        help="prepend these strings to each dictionary word (comma separated)",
    )


def build_target(args) -> Target | None:
    """Build the comparison target from the CLI arguments, if one was given."""
    text = getattr(args, "target", None)
    if not text:
        return None
    target_type = getattr(args, "target_type", "auto")
    if target_type == "auto":
        return target_from_string(text)
    if target_type == "address":
        return Target.from_address(text)
    if target_type == "pubkey":
        return Target.from_pubkey(text)
    if target_type == "privkey":
        return Target.from_privkey(text)
    return Target.from_hash160(text)


def combine_lengths(spec: str | None, default: tuple[int, ...], max_length: int) -> list[int]:
    """Parse ``--length 4`` / ``--length 3..6`` into a list of lengths."""
    if not spec:
        return list(default)
    text = spec.strip().replace(",", "..")
    if ".." in text:
        low, _, high = text.partition("..")
        try:
            start, end = int(low), int(high or low)
        except ValueError:
            raise UsageError(f"invalid length range {spec!r}") from None
        if start > end:
            start, end = end, start
    else:
        try:
            start = end = int(text)
        except ValueError:
            raise UsageError(f"invalid length {spec!r}") from None
    if start < 1:
        raise UsageError("length must be at least 1")
    if end > max_length:
        raise UsageError(
            f"length {end} exceeds the maximum supported length ({max_length}); "
            "searches that large are not practical anyway"
        )
    return list(range(start, end + 1))


def build_passphrase_space(
    args,
    default_charset: str | None,
    what: str = "passphrase",
    max_length: int = 16,
    default_lengths: tuple[int, ...] = (1,),
) -> CompositeSpace:
    """Build the candidate space for a passphrase style search.

    Two modes are supported and can be combined in one run:

    * charset mode (``--charset`` + ``--length``), optionally over a range of
      lengths, and
    * dictionary mode (``--words``) with optional case/leet/suffix mutations.
    """
    spaces: list[SearchSpace] = []
    labels: list[str] = []

    words_arg = getattr(args, "words", None)
    charset_arg = getattr(args, "charset", None) or default_charset

    if words_arg:
        words = load_words(words_arg)
        suffixes = tuple(filter(None, (getattr(args, "suffix", "") or "").split(",")))
        prefixes = tuple(filter(None, (getattr(args, "prefix", "") or "").split(",")))
        variants = build_word_variants(
            words,
            leet=bool(getattr(args, "leet", False)),
            case=not bool(getattr(args, "no_case", False)),
            suffixes=suffixes,
        )
        if prefixes:
            variants = list(dict.fromkeys([p + v for p in prefixes for v in variants]))
        spaces.append(
            SearchSpace.from_slots([Slot(tuple(variants), f"{what} dictionary word")], kind="text")
        )
        labels.append(f"dictionary ({len(variants):,} variants)")

    if charset_arg and not words_arg:
        charset = resolve_charset(charset_arg)
        lengths = combine_lengths(getattr(args, "length", None), default_lengths, max_length)
        for length in lengths:
            spaces.append(
                SearchSpace.from_slots(
                    [Slot(tuple(charset), f"{what} character {i + 1}") for i in range(length)],
                    kind="text",
                )
            )
            labels.append(f"charset length {length} ({len(charset) ** length:,} candidates)")

    if not spaces:
        raise UsageError(
            f"nothing to search: give a character set with --charset (and optionally --length) "
            f"or a dictionary with --words"
        )
    return CompositeSpace(spaces, kind="text", labels=labels)


def ownership_acknowledged(args) -> bool:
    return bool(getattr(args, "i_own_this", False) or getattr(args, "force", False))


def key_report(privkey_int: int | bytes, compressed: bool | None = None, network: str = "mainnet") -> dict:
    """Everything worth printing about a recovered private key."""
    key = privkey_int if isinstance(privkey_int, int) else int.from_bytes(privkey_int, "big")
    key_bytes = key.to_bytes(32, "big")
    report: dict = {
        "privkey_hex": key_bytes.hex(),
        "wif_compressed": encode_wif(key_bytes, True),
        "wif_uncompressed": encode_wif(key_bytes, False),
    }
    for compressed_flag in ((compressed,) if compressed is not None else (True, False)):
        pub = pubkey_from_privkey(key, compressed_flag)
        label = "compressed" if compressed_flag else "uncompressed"
        report[f"pubkey_{label}"] = pub.hex()
        report[f"address_{label}_p2pkh"] = p2pkh(pub, network)
    compressed_pub = pubkey_from_privkey(key, True)
    addresses = all_addresses(compressed_pub, network)
    for name in ("p2wpkh", "p2sh-p2wpkh", "p2tr"):
        if name in addresses:
            report[name.replace("-", "_")] = addresses[name]
    return report


def describe_target(target: Target | None) -> str:
    if target is None:
        return "no comparison target (checksum / structure validation only)"
    return target.describe()


def read_input_text(value: str | None, file_arg: str | None = None) -> str:
    """Accept either a literal value or ``file:PATH`` / ``--file`` input."""
    if file_arg:
        text = read_text(file_arg, "input file").strip()
        if not text:
            raise UsageError(f"file {file_arg} is empty")
        return text
    if value is None:
        raise UsageError("an input value is required")
    if value.startswith("file:"):
        text = read_text(value[5:], "input file").strip()
        if not text:
            raise UsageError(f"file {value[5:]} is empty")
        return text
    return value.strip()
