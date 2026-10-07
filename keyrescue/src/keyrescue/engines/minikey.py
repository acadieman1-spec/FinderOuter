"""Mini private keys with missing characters."""

from __future__ import annotations

import argparse

from ..compare import Target
from ..crypto.hashes import sha256
from ..crypto.base58 import ALPHABET as BASE58_ALPHABET
from ..crypto.minikey import MARKER, MINIKEY_LENGTHS, is_minikey, privkey_from_minikey
from ..errors import InvalidInput, UsageError
from ..search.charsets import resolve_charset
from ..search.runner import RecoveryEngine, RunConfig
from ..search.space import SearchSpace, count_positions
from . import common

__all__ = ["MiniKeyEngine"]


class MiniKeyEngine(RecoveryEngine):
    """Recover a mini private key (``S...``) with unreadable characters."""

    slug = "minikey"
    title = "Missing characters in a mini private key"
    description = (
        "Mini private keys are validated by a single SHA-256 check, which\n"
        "discards 255 of every 256 wrong guesses before any elliptic curve\n"
        "work happens, so this mode is comfortably fast."
    )
    examples = (
        'keyrescue minikey --input "SzavMBLoXU6kDrqtUVmf??" --target 1HZwkjkeaoZfTSaJxDw6aKkxp45agDiEzN',
        'keyrescue minikey --input "S6c56bnXQiBjk9mqSYE7ykVQ7NzrRy??" --target 1F3sAm6ZtwLAUnj7d38pGFxtP3RVEvtsbX',
    )
    cost_per_candidate = 2e-6
    default_chunk_size = 8192

    @classmethod
    def add_arguments(cls, parser: argparse.ArgumentParser) -> None:
        group = parser.add_argument_group("input")
        group.add_argument("--input", "-i", metavar="MINIKEY", help="mini private key, use ? for unknown characters")
        group.add_argument("--file", "-f", metavar="PATH", help="read the input from a file instead")
        group.add_argument(
            "--compressed",
            choices=("auto", "yes", "no"),
            default="auto",
            help="public key encoding used by the wallet that made the address",
        )
        group.add_argument("--charset", metavar="SET", default=None,
                           help="characters the missing characters may be (default: Base-58 alphabet)")
        common.add_common_target_args(parser)

    @classmethod
    def from_args(cls, args, config: RunConfig) -> "MiniKeyEngine":
        engine = cls(config)
        engine.args = args
        return engine

    # ------------------------------------------------------------------ setup
    def prepare(self) -> None:
        text = common.read_input_text(self.args.input, self.args.file)
        self.raw_input = "".join(text.split())
        if not self.raw_input.startswith("S"):
            raise InvalidInput("a mini private key always starts with 'S'")
        # '0', 'O', 'I' and 'l' are excluded from the Base-58 alphabet used by
        # mini keys, so the shared validator rejects them for us.
        length = count_positions(
            self.raw_input, BASE58_ALPHABET, "mini private key"
        )
        if length not in MINIKEY_LENGTHS:
            raise InvalidInput(
                f"a mini private key is one of {MINIKEY_LENGTHS} characters long, this one is {length}"
            )

        charset = resolve_charset(self.args.charset or "base58")
        self.charset = charset
        self.space = SearchSpace.from_template(self.raw_input, charset, kind="text", charset_name="base58")
        if not self.space.slots:
            raise UsageError(
                "the input contains no unknown characters, so there is nothing to search for "
                "(mark them with ? or use sets)"
            )
        self.marker_hashes_before_match = 0

        target = common.build_target(self.args)
        if target is None:
            raise UsageError(
                "a comparison target is required: pass the address, public key or HASH160 of the key"
            )
        self.target: Target = target

    def describe(self) -> str:
        return (
            f"{self.title}\n"
            f"  input:    {self.raw_input}  ({len(self.raw_input)} characters)\n"
            f"  target:   {common.describe_target(self.target)}"
        )

    def params(self) -> dict:
        return {
            "input": self.raw_input,
            "target": self.target.address or self.target.payload.hex(),
        }

    # ------------------------------------------------------------------- work
    def check(self, candidate: str) -> dict | None:
        # 1. the built in validity marker: SHA256(key + "?") must start with 0x00
        if sha256(f"{candidate}{MARKER}".encode("ascii"))[0] != 0:
            return None
        if not is_minikey(candidate):  # pragma: no cover - defensive
            return None
        # 2. the real check: derive the private key and compare
        privkey = privkey_from_minikey(candidate)
        if not self.target.match_privkey(privkey):
            return None
        return {
            "message": f"mini private key recovered: {candidate}",
            "valid_marker": True,
            **common.key_report(privkey),
        }
