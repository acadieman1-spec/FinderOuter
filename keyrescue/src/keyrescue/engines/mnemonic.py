"""Recovery of missing mnemonic (seed) words."""

from __future__ import annotations

import argparse
import re

from ..compare import Target
from ..crypto.bip32 import derive_path, parse_path
from ..crypto.bip39 import (
    electrum_mnemonic_to_seed,
    electrum_seed_type,
    load_wordlist,
    mnemonic_to_seed,
    normalize,
    normalize_mnemonic,
)
from ..crypto.hashes import hmac_sha512, pbkdf2_hmac_sha512, sha256
from ..errors import InvalidInput, UnsupportedInput, UsageError
from ..search.runner import RecoveryEngine, RunConfig
from ..search.space import SearchSpace, Slot
from . import common

__all__ = ["MnemonicEngine"]

ALLOWED_WORD_COUNTS = (12, 15, 18, 21, 24)
_ELECTRUM_SEED_KEY = b"Seed version"


def _pattern_to_regex(pattern: str) -> re.Pattern:
    """Turn ``aban?on`` style patterns into an anchored regular expression."""
    parts = []
    for char in pattern:
        if char in "?*":
            parts.append(".*?" if char == "*" else ".")
        else:
            parts.append(re.escape(char))
    return re.compile("^" + "".join(parts) + "$")


class MnemonicEngine(RecoveryEngine):
    """Find missing BIP-39 or Electrum mnemonic words."""

    slug = "mnemonic"
    title = "Missing mnemonic words"
    description = (
        "Restores BIP-39 or Electrum seed words that were lost or unreadable.\n"
        "Words can be given as '?' (anything), or as a partial word such as\n"
        "'aban?' or 'ab*on'. Candidates are checked against a known child key\n"
        "or address, and rejected by the seed checksum before any derivation."
    )
    examples = (
        'keyrescue mnemonic --input "ridge ? crystal ? ability ..." --type bip39 \\\n'
        "        --path m/84'/0'/0'/0/0 --target bc1q...",
        'keyrescue mnemonic --input "? abandon ? ..." --type electrum --language english \\\n'
        "        --path m/0'/0/0 --target 1HZwkjkeaoZfTSaJxDw6aKkxp45agDiEzN",
    )
    cost_per_candidate = 1.8e-3
    default_chunk_size = 64

    @classmethod
    def add_arguments(cls, parser: argparse.ArgumentParser) -> None:
        group = parser.add_argument_group("input")
        group.add_argument("--input", "-i", metavar="WORDS", help="mnemonic, use ? for unknown words")
        group.add_argument("--file", "-f", metavar="PATH", help="read the mnemonic from a file instead")
        group.add_argument("--type", choices=("bip39", "electrum"), default="bip39", help="seed scheme")
        group.add_argument("--language", default="english", help="word list name or a path to a word list file")
        group.add_argument("--wordlist", metavar="PATH", help="custom word list file (one word per line)")
        group.add_argument(
            "--path",
            default="m/44'/0'/0'/0/0",
            help="derivation path of the known child key/address (default: m/44'/0'/0'/0/0)",
        )
        common.add_common_target_args(parser)

    @classmethod
    def from_args(cls, args, config: RunConfig) -> "MnemonicEngine":
        engine = cls(config)
        engine.args = args
        return engine

    # ------------------------------------------------------------------ setup
    def prepare(self) -> None:
        text = common.read_input_text(self.args.input, self.args.file)
        words = normalize_mnemonic(text).split()
        if len(words) not in ALLOWED_WORD_COUNTS:
            raise InvalidInput(
                f"a mnemonic has {', '.join(str(c) for c in ALLOWED_WORD_COUNTS)} words, "
                f"this one has {len(words)}"
            )

        self.kind = self.args.type
        wordlist_name = self.args.wordlist or self.args.language
        self.wordlist = load_wordlist(wordlist_name, kind="electrum" if self.kind == "electrum" else "bip39")
        if self.kind == "electrum" and self.wordlist.size != 1626 and "electrum" not in self.wordlist.name:
            raise UsageError("Electrum mnemonics need the Electrum word list (--language english)")

        slots: list[Slot] = []
        parts: list[str | Slot] = []
        fixed_words: list[str] = []
        unknown_count = 0
        for index, word in enumerate(words):
            if word in ("?", "*"):
                candidates = tuple(self.wordlist.words)
            elif "?" in word or "*" in word:
                regex = _pattern_to_regex(word)
                candidates = tuple(w for w in self.wordlist.words if regex.match(w))
                if not candidates:
                    raise InvalidInput(f"word pattern {word!r} does not match anything in the word list")
            elif word in self.wordlist.words:
                candidates = ()
            else:
                raise InvalidInput(
                    f"word {index + 1} ({word!r}) is not in the {self.wordlist.name} word list"
                )

            if candidates:
                slots.append(Slot(candidates, f"word {index + 1}", index))
                parts.append(Slot(candidates, f"word {index + 1}", index))
                fixed_words.append("")
                unknown_count += 1
            else:
                parts.append(word)
                fixed_words.append(word)

        if not slots:
            raise UsageError("no unknown words found; use ? (or a pattern such as 'aban?') for the words to recover")
        self.space = SearchSpace.from_slots(parts, kind="words", separator=" ")
        self.space.words = fixed_words
        self.unknown_count = unknown_count

        self.path_text = self.args.path
        self.path_components = parse_path(self.path_text)

        target = common.build_target(self.args)
        if target is None:
            raise UsageError(
                "a comparison target is required: give one child address, public key or private key "
                "derived from this mnemonic"
            )
        self.target: Target = target

        # --- fast rejection data -------------------------------------------
        self.word_bits = self.wordlist.bits_per_word
        self.word_count = len(words)
        self.checksum_len = self.word_count // 3 if self.kind == "bip39" else 0
        self.slot_positions = [slot.position for slot in slots]
        self.slot_index_values = [
            tuple(self.wordlist.words.index(w) for w in slot.values) for slot in slots
        ]
        # unknown word positions get index 0 here; run_chunk overwrites them
        self.base_index = [self.wordlist.words.index(w) if w else 0 for w in fixed_words]
        self.fixed_bits = 0
        for index, word in enumerate(fixed_words):
            if word:
                shift = self.word_bits * (self.word_count - 1 - index)
                self.fixed_bits |= self.wordlist.words.index(word) << shift
        self.slot_shifts = [
            self.word_bits * (self.word_count - 1 - position) for position in self.slot_positions
        ]
        self.mask_low = (1 << self.checksum_len) - 1 if self.checksum_len else 0

    def describe(self) -> str:
        return (
            f"{self.title}\n"
            f"  scheme:   {self.kind} ({self.wordlist.name} word list)\n"
            f"  words:    {self.word_count} total, {self.unknown_count} unknown\n"
            f"  path:     {self.path_text}\n"
            f"  target:   {common.describe_target(self.target)}"
        )

    def params(self) -> dict:
        return {
            "input": self.space.template,
            "type": self.kind,
            "language": self.wordlist.name,
            "path": self.path_text,
            "target": self.target.address or self.target.payload.hex(),
        }

    # ------------------------------------------------------------- fast path
    def _is_plausible(self, bits: int) -> bool:
        """Reject candidates using the seed checksum before any PBKDF2 work."""
        if self.kind == "electrum":
            return True  # Electrum's version prefix check needs the words themselves
        entropy_len = self.word_bits * self.word_count - self.checksum_len
        entropy = (bits >> self.checksum_len).to_bytes(entropy_len // 8, "big")
        expected = sha256(entropy)[0] >> (8 - self.checksum_len) if self.checksum_len else 0
        return (bits & self.mask_low) == expected

    def run_chunk(self, start: int, count: int) -> tuple[int, int, list[dict]]:
        """Iterate the word space with integer arithmetic (no string rendering)."""
        sizes = [len(values) for values in self.slot_index_values]
        matches: list[dict] = []
        total = self.space.total
        end = min(total, start + count)

        digits = []
        value = start
        for size in sizes:
            digits.append(value % size)
            value //= size

        index = start
        while index < end:
            word_indices = list(self.base_index)
            bits = self.fixed_bits
            for position, shift, values, digit in zip(
                self.slot_positions, self.slot_shifts, self.slot_index_values, digits
            ):
                word_index = values[digit]
                word_indices[position] = word_index
                bits |= word_index << shift

            detail = self._check_indices(word_indices, bits)
            if detail is not None:
                mnemonic = " ".join(self.wordlist.words[i] for i in word_indices)
                matches.append({"index": index, "candidate": mnemonic, "detail": detail})

            index += 1
            for i in range(len(digits)):
                digits[i] += 1
                if digits[i] < sizes[i]:
                    break
                digits[i] = 0
            else:
                break
        return start, index - start, matches

    def check(self, candidate) -> dict | None:  # pragma: no cover - used by generic paths
        words = normalize_mnemonic(str(candidate)).split()
        try:
            indices = [self.wordlist.words.index(w) for w in words]
        except ValueError:
            return None
        bits = 0
        for word_index in indices:
            bits = (bits << self.word_bits) | word_index
        return self._check_indices(indices, bits)

    def _check_indices(self, word_indices: list[int], bits: int) -> dict | None:
        if not self._is_plausible(bits):
            return None
        mnemonic = " ".join(self.wordlist.words[i] for i in word_indices)

        if self.kind == "electrum":
            seed_type = electrum_seed_type(mnemonic)
            if seed_type is None:
                return None
            seed = electrum_mnemonic_to_seed(mnemonic)
        else:
            seed = mnemonic_to_seed(mnemonic)

        try:
            privkey, _ = derive_path(seed, self.path_components)
        except InvalidInput:
            return None
        if not self.target.match_privkey(privkey):
            return None

        detail = {
            "message": f"mnemonic recovered: {mnemonic}",
            "path": self.path_text,
            "child_privkey_hex": privkey.to_bytes(32, "big").hex(),
            **common.key_report(privkey, self.target.compressed),
        }
        if self.kind == "electrum":
            detail["electrum_seed_type"] = electrum_seed_type(mnemonic)
        return detail
