"""Recovery of a mnemonic extension passphrase (BIP-39 ``passphrase`` / Electrum seed extension)."""

from __future__ import annotations

import argparse

from ..crypto.bip32 import derive_path, parse_path
from ..crypto.bip39 import load_wordlist, normalize, normalize_mnemonic
from ..crypto.hashes import pbkdf2_hmac_sha512
from ..errors import InvalidInput, UsageError
from ..search.runner import RecoveryEngine, RunConfig
from . import common

__all__ = ["PassphraseEngine"]

_PBKDF2_ROUNDS = 2048


class PassphraseEngine(RecoveryEngine):
    """Brute force the extension word ("25th word") of a known mnemonic."""

    slug = "passphrase"
    title = "Missing mnemonic passphrase (extension word)"
    description = (
        "The mnemonic is complete but the optional passphrase that was mixed\n"
        "into it is unknown. Every candidate runs PBKDF2-HMAC-SHA512 (2048\n"
        "rounds) and one child key derivation, so expect a few thousand\n"
        "candidates per second per core."
    )
    examples = (
        'keyrescue passphrase --input "ridge crystal ability ... " --type bip39 \\\n'
        "        --charset alnum --length 1..4 --path m/84'/0'/0'/0/0 --target bc1q...",
        'keyrescue passphrase --input "ridge crystal ..." --type bip39 \\\n'
        '        --words "mywallet,trezor,ledger" --leet --suffix "1,!,123" --target 1HZwk...',
    )
    requires_ownership_ack = True
    cost_per_candidate = 1.6e-3
    default_chunk_size = 64

    @classmethod
    def add_arguments(cls, parser: argparse.ArgumentParser) -> None:
        group = parser.add_argument_group("input")
        group.add_argument("--input", "-i", metavar="WORDS", help="the complete mnemonic")
        group.add_argument("--file", "-f", metavar="PATH", help="read the mnemonic from a file instead")
        group.add_argument("--type", choices=("bip39", "electrum"), default="bip39", help="seed scheme")
        group.add_argument("--language", default="english", help="word list name or path to a word list file")
        group.add_argument("--wordlist", metavar="PATH", help="custom word list file")
        group.add_argument(
            "--path",
            default="m/44'/0'/0'/0/0",
            help="derivation path of the known child key/address (default: m/44'/0'/0'/0/0)",
        )
        common.add_common_target_args(parser)
        common.add_passphrase_args(parser, "passphrase")

    @classmethod
    def from_args(cls, args, config: RunConfig) -> "PassphraseEngine":
        engine = cls(config)
        engine.args = args
        return engine

    # ------------------------------------------------------------------ setup
    def prepare(self) -> None:
        text = common.read_input_text(self.args.input, self.args.file)
        self.words = normalize_mnemonic(text).split()
        self.kind = self.args.type

        wordlist = load_wordlist(self.args.wordlist or self.args.language,
                                kind="electrum" if self.kind == "electrum" else "bip39")
        unknown = [w for w in self.words if w not in wordlist.words]
        if unknown:
            raise InvalidInput(f"word(s) not in the {wordlist.name} list: {', '.join(unknown[:5])}")

        if self.kind == "bip39":
            from ..crypto.bip39 import validate_bip39

            ok, reason = validate_bip39(" ".join(self.words), wordlist)
            if not ok:
                raise InvalidInput(f"the mnemonic is not a valid BIP-39 mnemonic: {reason}")

        self.mnemonic = " ".join(self.words)
        self.path_text = self.args.path
        self.path_components = parse_path(self.path_text)

        target = common.build_target(self.args)
        if target is None:
            raise UsageError(
                "a comparison target is required: give a child address, public key or private key"
            )
        self.target = target

        self.space = common.build_passphrase_space(
            self.args,
            default_charset=None,
            what="passphrase",
            max_length=64,
            default_lengths=(1,),
        )
        # pre-compute the PBKDF2 password / salt prefix (the mnemonic is fixed)
        self.password = self.mnemonic.encode("utf-8")
        self.salt_prefix = b"mnemonic" if self.kind == "bip39" else b"electrum"

    def describe(self) -> str:
        return (
            f"{self.title}\n"
            f"  scheme:     {self.kind}\n"
            f"  mnemonic:   {len(self.words)} words (complete)\n"
            f"  path:       {self.path_text}\n"
            f"  target:     {common.describe_target(self.target)}\n"
            f"{self.space.describe()}"
        )

    def params(self) -> dict:
        return {
            "mnemonic": self.mnemonic,
            "type": self.kind,
            "path": self.path_text,
            "target": self.target.address or self.target.payload.hex(),
            "space": self.space.signature(),
        }

    # ------------------------------------------------------------------- work
    def check(self, candidate) -> dict | None:
        passphrase = normalize(str(candidate)).encode("utf-8")
        seed = pbkdf2_hmac_sha512(self.password, self.salt_prefix + passphrase, _PBKDF2_ROUNDS, 64)
        try:
            privkey, _ = derive_path(seed, self.path_components)
        except InvalidInput:
            return None
        if not self.target.match_privkey(privkey):
            return None
        return {
            "message": f"passphrase found: {candidate!r}",
            "passphrase": str(candidate),
            "path": self.path_text,
            "child_privkey_hex": privkey.to_bytes(32, "big").hex(),
            **common.key_report(privkey, self.target.compressed),
        }
