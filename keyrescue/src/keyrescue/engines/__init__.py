"""Recovery engines and their registry.

Each engine is a self-contained plugin: it declares its own command line
options, builds a search space, and implements one ``check`` method.  Adding a
new recovery mode means adding one module and one line to :data:`ENGINE_CLASSES`.
"""

from __future__ import annotations

from .base16 import Base16Engine
from .base58 import Base58Engine
from .bip38 import Bip38Engine
from .minikey import MiniKeyEngine
from .mnemonic import MnemonicEngine
from .passphrase import PassphraseEngine
from .walletdat import WalletDatEngine

__all__ = [
    "ENGINE_CLASSES",
    "ENGINES",
    "get_engine_class",
    "Base16Engine",
    "Base58Engine",
    "MiniKeyEngine",
    "MnemonicEngine",
    "PassphraseEngine",
    "Bip38Engine",
    "WalletDatEngine",
]

ENGINE_CLASSES = (
    Base16Engine,
    Base58Engine,
    MiniKeyEngine,
    MnemonicEngine,
    PassphraseEngine,
    Bip38Engine,
    WalletDatEngine,
)

ENGINES = {cls.slug: cls for cls in ENGINE_CLASSES}


def get_engine_class(slug: str):
    try:
        return ENGINES[slug]
    except KeyError:
        raise KeyError(f"unknown recovery mode {slug!r}; available: {', '.join(sorted(ENGINES))}") from None
