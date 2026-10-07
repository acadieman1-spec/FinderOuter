"""BIP-38 passphrase recovery."""

from __future__ import annotations

import argparse

from ..crypto.bip38 import SCRYPT_PARAMS_HARD, decrypt_bip38, parse_bip38
from ..errors import InvalidInput, UsageError
from ..search.runner import RecoveryEngine, RunConfig
from . import common

__all__ = ["Bip38Engine"]


class Bip38Engine(RecoveryEngine):
    """Recover the passphrase protecting a BIP-38 encrypted private key."""

    slug = "bip38"
    title = "Missing BIP-38 passphrase"
    description = (
        "BIP-38 keys are protected by scrypt (N=16384, r=8, p=8), which is\n"
        "deliberately expensive: budget roughly 50-100 ms per candidate per\n"
        "core. Keep the search space small (a few thousand candidates) and\n"
        "prefer targeted dictionaries over full character sets."
    )
    examples = (
        'keyrescue bip38 --input 6Pn... --charset alnum --length 1..4 --i-own-this',
        'keyrescue bip38 --input 6Pf... --words "vacation2019,summer2019" --leet --i-own-this',
    )
    requires_ownership_ack = True
    cost_per_candidate = 0.38
    default_chunk_size = 1

    @classmethod
    def add_arguments(cls, parser: argparse.ArgumentParser) -> None:
        group = parser.add_argument_group("input")
        group.add_argument("--input", "-i", metavar="BIP38", help="the BIP-38 key (starts with 6P)")
        group.add_argument("--file", "-f", metavar="PATH", help="read the BIP-38 key from a file instead")
        common.add_passphrase_args(parser, "passphrase")

    @classmethod
    def from_args(cls, args, config: RunConfig) -> "Bip38Engine":
        engine = cls(config)
        engine.args = args
        return engine

    # ------------------------------------------------------------------ setup
    def prepare(self) -> None:
        text = common.read_input_text(self.args.input, self.args.file)
        self.raw_input = "".join(text.split())
        if not self.raw_input.startswith("6P"):
            raise InvalidInput("a BIP-38 encrypted key always starts with '6P'")
        self.record = parse_bip38(self.raw_input)

        self.space = common.build_passphrase_space(
            self.args,
            default_charset=None,
            what="passphrase",
            max_length=64,
            default_lengths=(1,),
        )

    def describe(self) -> str:
        mode = "EC-multiplied" if self.record.ec_multiplied else "direct"
        lot = ""
        if self.record.has_lot_sequence:
            lot_no, seq_no = self.record.lot_and_sequence or (0, 0)
            lot = f", lot {lot_no} sequence {seq_no}"
        return (
            f"{self.title}\n"
            f"  key:       {self.raw_input[:12]}... ({mode}, "
            f"{'compressed' if self.record.compressed else 'uncompressed'}{lot})\n"
            f"  scrypt:    N={SCRYPT_PARAMS_HARD[0]} r={SCRYPT_PARAMS_HARD[1]} p={SCRYPT_PARAMS_HARD[2]}\n"
            f"{self.space.describe()}"
        )

    def params(self) -> dict:
        return {"input": self.raw_input, "space": self.space.signature()}

    # ------------------------------------------------------------------- work
    def check(self, candidate) -> dict | None:
        result = decrypt_bip38(self.record, str(candidate))
        if result is None:
            return None
        privkey, compressed = result
        int_key = int.from_bytes(privkey, "big")
        return {
            "message": f"passphrase found: {candidate!r}",
            "passphrase": str(candidate),
            "compressed": compressed,
            **common.key_report(int_key, compressed),
        }
