"""Bitcoin Core ``wallet.dat`` support.

A Core wallet encrypts a random 32 byte *master key* with a key derived from
the user passphrase.  The ``mkey`` record stores:

===================  ==========================================================
field                meaning
===================  ==========================================================
``crypted_key``      48 bytes = AES-256-CBC(master key || 0x10 * 16) with the
                     key/IV derived from the passphrase (PKCS#7 padding)
``salt``             8 random bytes
``derivation_method``0 = SHA-512 iteration (the only method Core ever shipped)
``iterations``       default 25000
===================  ==========================================================

Because the plaintext length (32 bytes) is a multiple of the AES block size,
PKCS#7 adds a full padding block of sixteen ``0x10`` bytes.  In CBC that gives
``C2 ^ D(C3) == 0x10 * 16``, which is the 128-bit check used to recognise a
correct passphrase without ever deriving a public key.

Derivation (``CCrypter::BytesToKeySHA512AES``)::

    buf = SHA512(passphrase || salt)
    repeat iterations-1 times: buf = SHA512(buf)
    key = buf[0:32]; iv = buf[32:48]
"""

from __future__ import annotations

import json
from dataclasses import dataclass
from pathlib import Path

from ..errors import InvalidInput
from .aes import AES256ECB
from .hashes import sha512

__all__ = [
    "MasterKeyRecord",
    "find_master_key_records",
    "load_record_from_params",
    "derive_key_iv",
    "check_password",
    "decrypt_master_key",
    "PADDING_BLOCK",
    "DEFAULT_ITERATIONS",
]

PADDING_BLOCK = b"\x10" * 16
DEFAULT_ITERATIONS = 25000
_MIN_ITERATIONS = 1
_MAX_ITERATIONS = 10_000_000


@dataclass(frozen=True)
class MasterKeyRecord:
    """One ``mkey`` record found in (or supplied for) a wallet."""

    crypted_key: bytes
    salt: bytes
    iterations: int
    derivation_method: int = 0
    offset: int = -1
    source: str = ""

    def __post_init__(self) -> None:
        if len(self.crypted_key) != 48:
            raise InvalidInput("mkey crypted_key must be 48 bytes")
        if len(self.salt) != 8:
            raise InvalidInput("mkey salt must be 8 bytes")
        if not _MIN_ITERATIONS <= self.iterations <= _MAX_ITERATIONS:
            raise InvalidInput(f"implausible iteration count {self.iterations}")

    @property
    def xor_mask(self) -> bytes:
        """``crypted_key[16:32]`` -- the CBC block used for the fast check."""
        return self.crypted_key[16:32]

    @property
    def cipher_block(self) -> bytes:
        """``crypted_key[32:48]`` -- the padding block, decrypted for the check."""
        return self.crypted_key[32:48]

    def to_dict(self) -> dict:
        return {
            "crypted_key": self.crypted_key.hex(),
            "salt": self.salt.hex(),
            "iterations": self.iterations,
            "derivation_method": self.derivation_method,
            "offset": self.offset,
            "source": self.source,
        }


def _serialized_mkey_value(haystack: bytes, start: int) -> MasterKeyRecord | None:
    """Try to read a serialised ``CMasterKey`` vector at ``start``."""
    # std::vector<unsigned char> vchCryptedKey  -> CompactSize(48) + 48 bytes
    end = start + 1 + 48 + 1 + 8 + 4 + 4 + 1
    if end > len(haystack):
        return None
    if haystack[start] != 48 or haystack[start + 49] != 8:
        return None
    if haystack[start + 58 : start + 62] != b"\x00\x00\x00\x00":  # derivation method 0
        return None
    if haystack[end - 1] != 0:  # empty vchOtherDerivationParameters
        return None
    iterations = int.from_bytes(haystack[start + 62 : start + 66], "little")
    if not _MIN_ITERATIONS <= iterations <= _MAX_ITERATIONS:
        return None
    return MasterKeyRecord(
        crypted_key=haystack[start + 1 : start + 49],
        salt=haystack[start + 50 : start + 58],
        iterations=iterations,
        derivation_method=0,
        offset=start,
    )


def find_master_key_records(data: bytes, source: str = "wallet.dat", max_records: int = 8) -> list[MasterKeyRecord]:
    """Locate ``mkey`` records inside a wallet.dat byte string.

    ``wallet.dat`` is a Berkeley DB file whose pages are not trivial to walk, so
    the value pattern of ``CMasterKey`` (a very specific 67 byte layout) is
    searched for directly and every candidate is structurally validated before
    being returned.  Duplicate records (some wallets store more than one, with
    a lower iteration count) are all returned.
    """
    needle = b"mkey"
    found: list[MasterKeyRecord] = []
    seen: set[int] = set()
    position = 0
    while True:
        position = data.find(needle, position)
        if position < 0:
            break
        # The serialised BDB item places the value within ~32 bytes of the key.
        for delta in range(1, 96):
            record = _serialized_mkey_value(data, position + len(needle) + delta)
            if record is not None and record.offset not in seen:
                record = MasterKeyRecord(
                    record.crypted_key, record.salt, record.iterations, 0, record.offset, source
                )
                seen.add(record.offset)
                found.append(record)
                break
        position += len(needle)
        if len(found) >= max_records:
            break
    return found


def load_record_from_params(params: str | Path | dict) -> list[MasterKeyRecord]:
    """Load mkey parameters supplied by the user.

    Accepts a path to a JSON file, a JSON string or a dict with the keys
    ``crypted_key`` (or ``encrypted_key``/``ekey``), ``salt`` and ``iterations``.
    """
    if isinstance(params, (str, Path)):
        text = Path(params).read_text(encoding="utf-8") if Path(str(params)).exists() else str(params)
        try:
            payload = json.loads(text)
        except json.JSONDecodeError as exc:
            raise InvalidInput(f"could not parse mkey parameters: {exc}") from None
    else:
        payload = params

    entries = payload.get("mkey") if isinstance(payload, dict) and "mkey" in payload else payload
    if isinstance(entries, dict):
        entries = [entries]
    if not isinstance(entries, list) or not entries:
        raise InvalidInput("mkey parameters must be an object or a list of objects")

    records = []
    for entry in entries:
        lowered = {str(k).lower(): v for k, v in entry.items()}
        crypted = lowered.get("crypted_key") or lowered.get("crypted_master_key") or lowered.get("ekey")
        salt = lowered.get("salt")
        iterations = lowered.get("iterations") or lowered.get("n_derive_iterations")
        if not crypted or not salt or not iterations:
            raise InvalidInput("each mkey entry needs crypted_key, salt and iterations")
        records.append(
            MasterKeyRecord(
                bytes.fromhex(str(crypted)),
                bytes.fromhex(str(salt)),
                int(iterations),
                int(lowered.get("derivation_method", 0)),
                -1,
                "user supplied",
            )
        )
    return records


def derive_key_iv(passphrase: bytes, salt: bytes, iterations: int, method: int = 0) -> tuple[bytes, bytes]:
    """Core's ``BytesToKeySHA512AES``: iterated SHA-512 over passphrase||salt."""
    if method != 0:
        raise InvalidInput(f"derivation method {method} is not supported by Bitcoin Core wallets")
    if not _MIN_ITERATIONS <= iterations <= _MAX_ITERATIONS:
        raise InvalidInput(f"implausible iteration count {iterations}")
    buf = sha512(passphrase + salt)
    for _ in range(iterations - 1):
        buf = sha512(buf)
    return buf[:32], buf[32:48]


def check_password(passphrase: bytes, record: MasterKeyRecord) -> bool:
    """Fast 128-bit test: does the decrypted padding block look like PKCS#7?"""
    key, _ = derive_key_iv(passphrase, record.salt, record.iterations, record.derivation_method)
    decrypted = AES256ECB(key).decrypt_block(record.cipher_block)
    return bytes(a ^ b for a, b in zip(decrypted, record.xor_mask)) == PADDING_BLOCK


def decrypt_master_key(passphrase: bytes, record: MasterKeyRecord) -> bytes | None:
    """Return the 32 byte master key for a correct passphrase."""
    if not check_password(passphrase, record):
        return None
    key, iv = derive_key_iv(passphrase, record.salt, record.iterations, record.derivation_method)
    plain = AES256ECB(key).cbc_decrypt(record.crypted_key, iv)
    return plain[:32]
