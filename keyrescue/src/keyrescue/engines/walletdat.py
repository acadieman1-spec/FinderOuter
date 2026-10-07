"""Bitcoin Core ``wallet.dat`` passphrase recovery."""

from __future__ import annotations

import argparse
from pathlib import Path

from ..fs import read_bytes
from ..crypto.core_wallet import (
    DEFAULT_ITERATIONS,
    MasterKeyRecord,
    check_password,
    decrypt_master_key,
    find_master_key_records,
    load_record_from_params,
)
from ..errors import InvalidInput, UsageError
from ..search.runner import RecoveryEngine, RunConfig
from . import common

__all__ = ["WalletDatEngine"]


class WalletDatEngine(RecoveryEngine):
    """Recover the passphrase of an encrypted Bitcoin Core wallet."""

    slug = "wallet"
    title = "Missing bitcoin core wallet.dat password"
    description = (
        "Bitcoin Core derives its AES key with ~25,000 SHA-512 rounds, so\n"
        "expect roughly 50-150 candidates per second per core. The passphrase\n"
        "is confirmed by a 128-bit check on the encrypted master key, and the\n"
        "recovered master key is printed so you can unlock the wallet."
    )
    examples = (
        'keyrescue wallet --file wallet.dat --charset alnum --length 1..6 --i-own-this',
        'keyrescue wallet --params mkey.json --words "vacation,wallet,summer" --i-own-this',
    )
    requires_ownership_ack = True
    cost_per_candidate = 3.5e-5
    default_chunk_size = 1

    @classmethod
    def add_arguments(cls, parser: argparse.ArgumentParser) -> None:
        group = parser.add_argument_group("input")
        group.add_argument("--file", "-f", metavar="PATH", help="path to the wallet.dat file")
        group.add_argument(
            "--params",
            metavar="JSON|PATH",
            help="mkey parameters as JSON instead of a wallet file "
                 '(e.g. {"crypted_key":"..","salt":"..","iterations":25000})',
        )
        group.add_argument("--list-mkeys", action="store_true", help="only show the mkey records found and exit")
        common.add_passphrase_args(parser, "password")

    @classmethod
    def from_args(cls, args, config: RunConfig) -> "WalletDatEngine":
        engine = cls(config)
        engine.args = args
        return engine

    # ------------------------------------------------------------------ setup
    def prepare(self) -> None:
        if self.args.params:
            self.records: list[MasterKeyRecord] = load_record_from_params(self.args.params)
            self.source = "user supplied parameters"
        elif self.args.file:
            path = Path(self.args.file)
            data = read_bytes(path, "wallet file")
            if len(data) < 128:
                raise InvalidInput("that file is too small to be a wallet.dat")
            self.records = find_master_key_records(data, source=str(path))
            self.source = str(path)
            if not self.records:
                raise InvalidInput(
                    "no mkey record was found in that file. Checks: is the wallet encrypted? "
                    "Is this really a wallet.dat (not a descriptors or SQLite wallet)? "
                    "You can also supply the parameters directly with --params."
                )
        else:
            raise UsageError("give a wallet file with --file or mkey parameters with --params")

        if getattr(self.args, "list_mkeys", False):
            self._list_only = True
            self.space = None
            return

        self.space = common.build_passphrase_space(
            self.args,
            default_charset=None,
            what="password",
            max_length=64,
            default_lengths=(1,),
        )
        # one password costs the key derivation, scaled by the iteration count the
        # wallet declares and by how many records each candidate is tested against
        iterations = max(record.iterations for record in self.records)
        self.cost_per_candidate = 1.3e-6 * (iterations / 1000) * len(self.records)

    def preflight(self) -> bool:
        """``--list-mkeys``: report the records found so they can be copied to --params."""
        if not getattr(self, "_list_only", False):
            return False
        print(f"{self.title}\n  wallet: {self.source}\n")
        for index, record in enumerate(self.records, start=1):
            print(f"mkey {index}")
            print(f"  offset           {record.offset if record.offset >= 0 else 'unknown'}")
            print(f"  iterations       {record.iterations:,}")
            print(f"  derivation method {record.derivation_method}")
            print(f"  salt             {record.salt.hex()}")
            print(f"  crypted_key      {record.crypted_key.hex()}")
            print()
        print("Search that wallet by copying a record above, for example:")
        example = '{"crypted_key": "...", "salt": "...", "iterations": 25000}'
        print("  keyrescue wallet --params '" + example + "' \\")
        print("      --words guesses.txt --i-own-this")
        print()
        print("Or just run the mode without --list-mkeys to try the passwords against every record.")
        return True

    def describe(self) -> str:
        lines = [self.title, f"  wallet:   {self.source}"]
        for index, record in enumerate(self.records, start=1):
            lines.append(
                f"  mkey {index}: {record.iterations:,} iterations, salt {record.salt.hex()}"
                f"{f', offset {record.offset}' if record.offset >= 0 else ''}"
            )
        if self.space is not None:
            lines.append(self.space.describe())
        return "\n".join(lines)

    def params(self) -> dict:
        return {
            "source": self.source,
            "mkeys": [record.to_dict() for record in self.records],
            "space": self.space.signature() if self.space is not None else "",
        }

    def post_process(self, matches) -> list[str]:
        if matches:
            return ["Keep the master key safe: it decrypts every key in the wallet."]
        return []

    # ------------------------------------------------------------------- work
    def check(self, candidate) -> dict | None:
        password = str(candidate).encode("utf-8")
        for index, record in enumerate(self.records):
            if not check_password(password, record):
                continue
            master = decrypt_master_key(password, record)
            detail = {
                "message": f"password found: {candidate!r}",
                "password": str(candidate),
                "iterations": record.iterations,
                "mkey_index": index,
            }
            if master is not None:
                detail["master_key_hex"] = master.hex()
                detail["note"] = (
                    "Use this master key with your wallet tooling to unlock the wallet, "
                    "or start bitcoin-core with the recovered passphrase."
                )
            return detail
        return None
