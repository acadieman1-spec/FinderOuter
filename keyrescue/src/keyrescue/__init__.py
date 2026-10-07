"""KeyRescue -- offline Bitcoin key and passphrase recovery.

KeyRescue helps you get back into *your own* wallets when part of the backup is
damaged or forgotten: unreadable characters on a paper wallet, a lost
mnemonic word, a forgotten BIP-38 passphrase, a wallet.dat password.  It never
phones home, it needs no network at all, and every recovery mode is a plugin
that can be scripted.

The package is organised as:

``keyrescue.crypto``
    Standards: Base58/Bech32, secp256k1, BIP-32/39/38, mini private keys,
    Bitcoin Core wallet encryption, AES, hashes.
``keyrescue.search``
    Search spaces, the parallel runner, progress reporting and checkpoints.
``keyrescue.engines``
    One module per recovery mode, registered in :mod:`keyrescue.engines`.
``keyrescue.licensing``
    Offline Ed25519 signed license keys and the tier/limit matrix.
"""

from __future__ import annotations

from .errors import (
    EXIT_INTERRUPTED,
    EXIT_LICENSE,
    EXIT_NO_RESULT,
    EXIT_OK,
    EXIT_USAGE,
    InvalidEncoding,
    InvalidInput,
    KeyRescueError,
    LicenseError,
    UnsupportedInput,
    UsageError,
)
from .version import __version__

__all__ = [
    "__version__",
    "KeyRescueError",
    "UsageError",
    "InvalidInput",
    "InvalidEncoding",
    "UnsupportedInput",
    "LicenseError",
    "EXIT_OK",
    "EXIT_NO_RESULT",
    "EXIT_USAGE",
    "EXIT_LICENSE",
    "EXIT_INTERRUPTED",
]
