"""BIP-39 mnemonics and Electrum (v2) mnemonics."""

from __future__ import annotations

import unicodedata
from dataclasses import dataclass
from functools import lru_cache
from pathlib import Path

from ..errors import InvalidInput, UnsupportedInput
from ..fs import read_text
from .hashes import hmac_sha512, pbkdf2_hmac_sha512, sha256

__all__ = [
    "WordList",
    "load_wordlist",
    "available_wordlists",
    "validate_bip39",
    "entropy_to_mnemonic",
    "mnemonic_to_entropy",
    "mnemonic_to_seed",
    "electrum_mnemonic_to_seed",
    "electrum_seed_type",
    "normalize",
    "normalize_mnemonic",
    "BIP39_STRENGTHS",
]

BIP39_STRENGTHS = (128, 160, 192, 224, 256)
_BIP39_SALT_PREFIX = "mnemonic"
_ELECTRUM_SALT_PREFIX = "electrum"
_ELECTRUM_SEED_KEY = b"Seed version"
_DATA_DIR = Path(__file__).resolve().parent.parent / "data" / "wordlists"


def normalize(text: str) -> str:
    """NFKD normalisation required by BIP-39 (and used by Electrum).

    Applied to mnemonics *and* passphrases.  Case is preserved on purpose: a
    BIP-39 passphrase is case sensitive, so "Abc" and "abc" are different seeds.
    """
    return unicodedata.normalize("NFKD", text)


def normalize_mnemonic(text: str) -> str:
    """Canonical form of a mnemonic: NFKD, single spaces, lowercase.

    Word lists are all lowercase, so wallets accept a mnemonic written with a
    capital letter or line breaks.  Use this for mnemonics, never for
    passphrases.
    """
    return " ".join(normalize(text).lower().split())


@dataclass(frozen=True)
class WordList:
    """A mnemonic word list."""

    name: str
    words: tuple[str, ...]
    kind: str = "bip39"  # bip39 | electrum

    @property
    def size(self) -> int:
        return len(self.words)

    @property
    def bits_per_word(self) -> int:
        if self.size & (self.size - 1):
            raise InvalidInput(f"word list of size {self.size} is not a power of two")
        return self.size.bit_length() - 1

    def index_of(self, word: str) -> int:
        """Index of ``word`` in this list (raises :class:`InvalidInput` when absent)."""
        try:
            return self._index_map()[word]
        except KeyError:
            raise InvalidInput(f"word {word!r} is not in the {self.name} list") from None

    def _index_map(self) -> dict[str, int]:
        """Word -> index lookups, built once per list and cached on the instance."""
        cached = self.__dict__.get("_index_cache")
        if cached is None:
            cached = {word: index for index, word in enumerate(self.words)}
            object.__setattr__(self, "_index_cache", cached)
        return cached

    def prefix_matches(self, prefix: str) -> list[str]:
        """All words starting with ``prefix`` (used for partial word recovery)."""
        prefix = prefix.lower()
        return [w for w in self.words if w.startswith(prefix)]


@lru_cache(maxsize=32)
def load_wordlist(name: str = "english", kind: str = "bip39") -> WordList:
    """Load a bundled word list, or a file path ending in ``.txt``."""
    candidate = Path(name)
    if candidate.suffix == ".txt" and candidate.exists():
        words = _read_words(candidate)
        return WordList(candidate.stem, tuple(words), kind)
    file = _DATA_DIR / f"{kind}_{name.lower()}.txt"
    if not file.exists():
        raise InvalidInput(f"unknown word list {name!r}; available: {', '.join(available_wordlists(kind))}")
    return WordList(name.lower(), tuple(_read_words(file)), kind)


def _read_words(path: Path) -> list[str]:
    words = [w.strip() for w in read_text(path, "word list").splitlines() if w.strip()]
    if len(words) not in (1626, 2048):  # BIP-39 (2048) and Electrum (1626) sizes
        raise InvalidInput(f"word list {path.name} has unexpected size {len(words)}")
    return words


def available_wordlists(kind: str = "bip39") -> list[str]:
    if not _DATA_DIR.exists():  # pragma: no cover - packaging safeguard
        return []
    return sorted(f.stem[len(kind) + 1 :] for f in _DATA_DIR.glob(f"{kind}_*.txt"))


def _indices(wordlist: WordList, words: list[str]) -> list[int]:
    """Word -> index for every word, naming the first word that is unknown."""
    indices = []
    for position, word in enumerate(words, 1):
        try:
            indices.append(wordlist.index_of(word))
        except InvalidInput:
            raise InvalidInput(
                f"word {position} ({word!r}) is not in the {wordlist.name} word list"
            ) from None
    return indices


def validate_bip39(mnemonic: str, wordlist: WordList | None = None) -> tuple[bool, str]:
    """Validate a BIP-39 mnemonic, returning ``(ok, reason)``."""
    words = normalize_mnemonic(mnemonic).split()
    if len(words) not in (12, 15, 18, 21, 24):
        return False, f"a BIP-39 mnemonic has 12/15/18/21/24 words, this one has {len(words)}"
    wordlist = wordlist or load_wordlist("english")
    known = wordlist._index_map()
    unknown = [w for w in words if w not in known]
    if unknown:
        return False, f"not in word list: {', '.join(unknown[:4])}"
    try:
        mnemonic_to_entropy(mnemonic, wordlist)
    except InvalidInput as exc:
        return False, str(exc)
    return True, "valid BIP-39 mnemonic"


def entropy_to_mnemonic(entropy: bytes, wordlist: WordList | None = None) -> str:
    """Encode entropy as a BIP-39 mnemonic (used by tests and examples)."""
    wordlist = wordlist or load_wordlist("english")
    if len(entropy) * 8 not in BIP39_STRENGTHS:
        raise InvalidInput("entropy must be 16/20/24/28/32 bytes")
    checksum_bits = len(entropy) * 8 // 32
    checksum = sha256(entropy)[0]
    bits = "".join(f"{b:08b}" for b in entropy) + f"{checksum:08b}"[:checksum_bits]
    words = [wordlist.words[int(bits[i : i + 11], 2)] for i in range(0, len(bits), 11)]
    return " ".join(words)


def mnemonic_to_entropy(mnemonic: str, wordlist: WordList | None = None) -> bytes:
    """Decode a BIP-39 mnemonic back to entropy, verifying the checksum."""
    wordlist = wordlist or load_wordlist("english")
    words = normalize_mnemonic(mnemonic).split()
    if len(words) not in (12, 15, 18, 21, 24):
        raise InvalidInput(
            f"a BIP-39 mnemonic has 12, 15, 18, 21 or 24 words, this one has {len(words)}"
        )
    bits = "".join(f"{wordlist.index_of(word):011b}" for word in words)
    checksum_len = len(bits) // 33
    entropy_bits = bits[: len(bits) - checksum_len]
    entropy = int(entropy_bits, 2).to_bytes(len(entropy_bits) // 8, "big")
    expected = f"{sha256(entropy)[0]:08b}"[:checksum_len]
    if bits[-checksum_len:] != expected:
        raise InvalidInput("invalid mnemonic checksum")
    return entropy


def mnemonic_to_seed(mnemonic: str, passphrase: str = "") -> bytes:
    """BIP-39 seed: PBKDF2-HMAC-SHA512 over the NFKD normalised mnemonic."""
    password = normalize_mnemonic(mnemonic).encode("utf-8")
    salt = (_BIP39_SALT_PREFIX + normalize(passphrase)).encode("utf-8")
    return pbkdf2_hmac_sha512(password, salt, 2048, 64)


def electrum_mnemonic_to_seed(mnemonic: str, passphrase: str = "") -> bytes:
    """Electrum v2 seed: PBKDF2-HMAC-SHA512 with the ``electrum`` salt prefix."""
    password = normalize_mnemonic(mnemonic).encode("utf-8")
    salt = (_ELECTRUM_SALT_PREFIX + normalize(passphrase)).encode("utf-8")
    return pbkdf2_hmac_sha512(password, salt, 2048, 64)


def electrum_seed_type(mnemonic: str) -> str | None:
    """Classify an Electrum v2 mnemonic: standard / segwit / 2fa, or None.

    Electrum hashes ``HMAC-SHA512(key=b"Seed version", msg=mnemonic)`` and looks
    at the hex prefix: ``01`` standard, ``100`` segwit, ``101`` 2FA.
    """
    text = normalize_mnemonic(mnemonic).encode("utf-8")
    version = hmac_sha512(_ELECTRUM_SEED_KEY, text).hex()
    if version.startswith("01"):
        return "standard"
    if version.startswith("100"):
        return "segwit"
    if version.startswith("101"):
        return "2fa"
    return None


def electrum_v1_seed(mnemonic: str) -> bytes:
    """Old (pre-2.0) Electrum seed stretching -- rejected by this build.

    Electrum v1 uses 100,000 SHA-256 rounds and a non-BIP32 key tree; the seed
    itself has no checksum, so a partial mnemonic can never be verified. Rather
    than silently returning something wrong we refuse it explicitly.
    """
    raise UnsupportedInput(
        "old Electrum (v1) mnemonics are not supported: they have no built-in checksum, "
        "so missing or damaged words cannot be verified. Restore it with Electrum 2.x "
        "or use the original wallet backup."
    )
