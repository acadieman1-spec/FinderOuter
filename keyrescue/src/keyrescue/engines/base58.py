"""Base-58 strings (WIF keys, addresses, BIP-38 keys) with missing characters."""

from __future__ import annotations

import argparse

from ..compare import Target, target_from_string
from ..crypto.base58 import ALPHABET as BASE58_ALPHABET, b58check_decode
from ..crypto.wif import decode_wif
from ..errors import InvalidEncoding, InvalidInput, UsageError
from ..search.charsets import resolve_charset
from ..search.runner import RecoveryEngine, RunConfig
from ..search.space import SearchSpace, count_positions
from . import common

__all__ = ["Base58Engine"]

BASE58_CHARS = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz"


def detect_type(text: str) -> str:
    """Guess what a damaged Base-58 string is."""
    if text.startswith("6P"):
        return "bip38"
    if len(text) in (51, 52) and text[0] in "5KL":
        return "wif"
    if 26 <= len(text) <= 35 and text[0] in "13":
        return "address"
    return "unknown"


class Base58Engine(RecoveryEngine):
    """Recover damaged Base-58 data: WIF keys, addresses or BIP-38 keys."""

    slug = "base58"
    title = "Missing characters in a Base-58 string"
    description = (
        "Base-58 checksummed data with unreadable characters: a WIF private\n"
        "key, a P2PKH/P2SH address or a BIP-38 encrypted key. The Base-58\n"
        "checksum rejects wrong guesses immediately, so this mode is fast."
    )
    examples = (
        'keyrescue base58 --input "L1aW4aubDFB7yfras2S1mN3an???R5XnBz???" --target 1HZwkjkeaoZfTSaJxDw6aKkxp45agDiEzN',
        'keyrescue base58 --input "5HueCGU8rMjxEXxiPuD5BDku4MkFqeZyd4dZ?jvhTVqvbTLvyT?" --target-address-type p2pkh',
    )
    requires_ownership_ack = False
    cost_per_candidate = 7.5e-6
    default_chunk_size = 8192

    @classmethod
    def add_arguments(cls, parser: argparse.ArgumentParser) -> None:
        group = parser.add_argument_group("input")
        group.add_argument("--input", "-i", metavar="BASE58", help="Base-58 string, use ? for unknown characters")
        group.add_argument("--file", "-f", metavar="PATH", help="read the input from a file instead")
        group.add_argument(
            "--type",
            choices=("auto", "wif", "address", "bip38"),
            default="auto",
            help="what the string is (default: auto detect)",
        )
        group.add_argument(
            "--address-type",
            choices=("auto", "p2pkh", "p2sh"),
            default="auto",
            help="when recovering an address, restrict the expected type",
        )
        group.add_argument("--charset", metavar="SET", default=None,
                           help="characters the missing characters may be (default: Base-58 alphabet)")
        common.add_common_target_args(parser)

    @classmethod
    def from_args(cls, args, config: RunConfig) -> "Base58Engine":
        engine = cls(config)
        engine.args = args
        return engine

    # ------------------------------------------------------------------ setup
    def prepare(self) -> None:
        text = common.read_input_text(self.args.input, self.args.file)
        self.raw_input = "".join(text.split())
        count_positions(self.raw_input, BASE58_ALPHABET, "Base-58 string")

        self.input_type = self.args.type if self.args.type != "auto" else detect_type(self.raw_input)
        if self.input_type == "unknown":
            raise InvalidInput(
                "could not tell whether this is a WIF key, an address or a BIP-38 key; "
                "pass --type explicitly"
            )

        charset = resolve_charset(self.args.charset or "base58")
        self.charset = charset
        self.space = SearchSpace.from_template(self.raw_input, charset, kind="text", charset_name="base58")
        if not self.space.slots:
            raise UsageError(
                "the input contains no unknown characters, so there is nothing to search for "
                "(mark them with ? or use sets such as {0o})"
            )

        self.target: Target | None = common.build_target(self.args)
        if self.input_type == "wif" and self.target is None:
            raise UsageError(
                "recovering a WIF key needs a comparison target such as its address, because a "
                "Base-58 checksum alone matches many wrong candidates"
            )
        if self.input_type == "address" and self.target is None:
            # the damaged string itself is the check: a valid checksum is enough
            self.self_check = True
        self.self_check = self.input_type in ("address", "bip38") and self.target is None

    def describe(self) -> str:
        return (
            f"{self.title}\n"
            f"  input:    {self.raw_input}  ({self.input_type})\n"
            f"  charset:  {self.charset}\n"
            f"  target:   {common.describe_target(self.target)}"
            + ("\n  mode:     checksum validation only" if self.self_check else "")
        )

    def params(self) -> dict:
        return {
            "input": self.raw_input,
            "type": self.input_type,
            "target": (self.target.address or self.target.payload.hex()) if self.target else None,
        }

    # ------------------------------------------------------------------- work
    def check(self, candidate: str) -> dict | None:
        try:
            payload = b58check_decode(candidate)
        except InvalidEncoding:
            return None

        kind = self.input_type

        if kind == "address":
            if len(payload) != 21:
                return None
            version = payload[0]
            if self.args.address_type == "p2pkh" and version != 0x00:
                return None
            if self.args.address_type == "p2sh" and version != 0x05:
                return None
            if version not in (0x00, 0x05):
                return None
            detail = {"message": f"valid address found: {candidate}"}
            if self.target is not None and candidate != self.target.address:
                return None
            return detail

        if kind == "bip38":
            if len(payload) != 39 or payload[0] != 0x01 or payload[1] not in (0x42, 0x43):
                return None
            return {"message": f"valid BIP-38 key found: {candidate}"}

        # WIF
        try:
            info = decode_wif(candidate)
        except (InvalidEncoding, InvalidInput):
            return None
        if self.target is None or not self.target.match_privkey(info.privkey):
            return None
        key = info.privkey_int
        return {
            "message": f"WIF recovered: {candidate}",
            "compressed": info.compressed,
            **common.key_report(key, info.compressed),
        }
