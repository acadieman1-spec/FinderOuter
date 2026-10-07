"""Base-16 (hexadecimal) private keys with missing characters."""

from __future__ import annotations

import argparse

from ..compare import Target
from ..errors import InvalidInput, UsageError
from ..search.charsets import resolve_charset
from ..search.runner import RecoveryEngine, RunConfig
from ..search.space import SearchSpace, count_positions
from . import common

__all__ = ["Base16Engine"]


class Base16Engine(RecoveryEngine):
    """Recover a hex private key that is missing some of its 64 characters."""

    slug = "hex"
    title = "Missing characters in a base-16 private key"
    description = (
        "A 64 character hexadecimal private key where some characters are\n"
        "unreadable. Each candidate is turned into a public key and compared\n"
        "against the address/public key you provide."
    )
    examples = (
        'keyrescue hex --input "e9{7}...{?}..." --target 1HZwkjkeaoZfTSaJxDw6aKkxp45agDiEzN',
        'keyrescue hex --file damaged-key.txt --target 1KbCTq... --charset 0123456789abcdef',
    )
    requires_ownership_ack = False
    cost_per_candidate = 3.3e-5
    default_chunk_size = 4096

    @classmethod
    def add_arguments(cls, parser: argparse.ArgumentParser) -> None:
        group = parser.add_argument_group("input")
        group.add_argument("--input", "-i", metavar="HEX", help="hex private key, use ? for unknown characters")
        group.add_argument("--file", "-f", metavar="PATH", help="read the input from a file instead")
        group.add_argument("--charset", metavar="SET", default=None,
                           help="characters the missing digits may be (default: hex)")
        common.add_common_target_args(parser)

    @classmethod
    def from_args(cls, args, config: RunConfig) -> "Base16Engine":
        engine = cls(config)
        engine.args = args
        return engine

    # ------------------------------------------------------------------ setup
    def prepare(self) -> None:
        text = common.read_input_text(self.args.input, self.args.file)
        cleaned = "".join(text.split()).lower()
        length = count_positions(cleaned, "0123456789abcdef", "hexadecimal key")
        if length != 64:
            raise InvalidInput(
                f"a hexadecimal private key is 64 characters long, this one is {length}"
            )

        charset = resolve_charset(self.args.charset or "hex")
        self.charset = charset
        self.space = SearchSpace.from_template(cleaned, charset, kind="text", charset_name="hex")
        if not self.space.slots:
            raise UsageError(
                "the input contains no unknown characters, so there is nothing to search for "
                "(mark them with ? or use sets such as {0-9a-f})"
            )
        self.raw_input = cleaned

        target = common.build_target(self.args)
        if target is None:
            raise UsageError(
                "a comparison target is required: a hexadecimal key has no checksum, so an "
                "address, public key or HASH160 is needed to recognise the right candidate"
            )
        if target.kind == "privkey":
            raise UsageError("comparing a hex key against another private key is pointless")
        self.target: Target = target

    def describe(self) -> str:
        return (
            f"{self.title}\n"
            f"  input:    {self.raw_input}\n"
            f"  charset:  {self.charset}\n"
            f"  target:   {common.describe_target(self.target)}"
        )

    def params(self) -> dict:
        return {
            "input": self.raw_input,
            "target": self.target.address or self.target.payload.hex(),
            "target_kind": self.target.kind,
        }

    # ------------------------------------------------------------------- work
    def check(self, candidate: str) -> dict | None:
        key = int(candidate, 16)
        if not 1 <= key < 0xFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFEBAAEDCE6AF48A03BBFD25E8CD0364141:
            return None
        if not self.target.match_privkey(key):
            return None
        return {"message": f"private key found: {candidate}", **common.key_report(key)}
