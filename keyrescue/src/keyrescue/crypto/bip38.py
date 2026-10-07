"""BIP-38 encrypted private keys.

Implements both decryption paths of the proposal:

* non EC-multiplied keys (``0x01 0x42`` prefix, flag byte ``0xC0``)
* EC-multiplied keys (``0x01 0x43`` prefix, flag byte ``0xE0``), with and
  without lot/sequence numbers

References: ``bip-0038.mediawiki``. The passphrase is NFC normalised as the
proposal requires.
"""

from __future__ import annotations

import hashlib
import unicodedata
from dataclasses import dataclass, field

from ..errors import InvalidEncoding, InvalidInput
from . import base58
from .aes import AES256ECB
from .hashes import double_sha256, sha256
from .secp256k1 import N, is_valid_privkey, pubkey_from_privkey

__all__ = ["Bip38Record", "parse_bip38", "decrypt_bip38", "is_bip38", "SCRYPT_PARAMS_HARD"]

# n, r, p for the "owner" step (deliberately expensive) and the derived step.
SCRYPT_PARAMS_HARD = (16384, 8, 8)
SCRYPT_PARAMS_SOFT = (1024, 1, 1)
_SCRYPT_MAXMEM = 256 * 1024 * 1024


def _nfc(text: str) -> bytes:
    return unicodedata.normalize("NFC", text).encode("utf-8")


def _scrypt(password: bytes, salt: bytes, n: int, r: int, p: int, dklen: int) -> bytes:
    return hashlib.scrypt(password, salt=salt, n=n, r=r, p=p, dklen=dklen, maxmem=_SCRYPT_MAXMEM)


@dataclass(frozen=True)
class Bip38Record:
    """A parsed BIP-38 string (no passphrase involved yet)."""

    flagbyte: int
    address_hash: bytes
    owner_entropy: bytes
    encrypted: bytes
    ec_multiplied: bool
    has_lot_sequence: bool
    compressed: bool
    text: str = ""
    extra: dict = field(default_factory=dict)

    @property
    def lot_and_sequence(self) -> tuple[int, int] | None:
        if not self.has_lot_sequence:
            return None
        value = int.from_bytes(self.owner_entropy[4:8], "big")
        return value // 4096, value % 4096


def is_bip38(text: str) -> bool:
    text = text.strip()
    if not text.startswith("6P"):
        return False
    try:
        parse_bip38(text)
        return True
    except Exception:
        return False


def parse_bip38(text: str) -> Bip38Record:
    """Decode the Base58Check structure of a BIP-38 string."""
    text = text.strip()
    payload = base58.b58check_decode(text)
    if len(payload) != 39:
        raise InvalidInput(f"BIP-38 payload must be 39 bytes, got {len(payload)}")
    if payload[0] != 0x01 or payload[1] not in (0x42, 0x43):
        raise InvalidEncoding("not a BIP-38 string (expected 0x0142 or 0x0143 prefix)")

    ec_multiplied = payload[1] == 0x43
    flagbyte = payload[2]
    address_hash = payload[3:7]

    # Flag byte (BIP-38 "Byte 3"): the top two bits are 11 for non-EC-multiplied
    # keys and 00 for EC-multiplied keys; 0x20 means compressed; 0x04 marks a
    # lot/sequence number (EC-multiplied only); every other bit must be zero.
    if ec_multiplied:
        if flagbyte & ~(0x20 | 0x04):
            raise InvalidInput(f"unsupported EC-multiplied flag byte 0x{flagbyte:02x}")
        owner_entropy = payload[7:15]
        encrypted = payload[15:39]
        has_lot = bool(flagbyte & 0x04)
    else:
        if flagbyte & 0xC0 != 0xC0:
            raise InvalidInput(
                "non-EC-multiplied keys must have the top two flag bits set (0xC0)"
            )
        if flagbyte & ~(0xC0 | 0x20):
            raise InvalidInput(f"unsupported non-EC-multiplied flag byte 0x{flagbyte:02x}")
        owner_entropy = b""
        encrypted = payload[7:39]
        has_lot = False

    return Bip38Record(
        flagbyte=flagbyte,
        address_hash=address_hash,
        owner_entropy=owner_entropy,
        encrypted=encrypted,
        ec_multiplied=ec_multiplied,
        has_lot_sequence=has_lot,
        compressed=bool(flagbyte & 0x20),
        text=text,
    )


def _check_address_hash(privkey: int, compressed: bool, address_hash: bytes) -> bool:
    from .addresses import p2pkh
    from .wif import encode_wif

    pub = pubkey_from_privkey(privkey, compressed)
    address = p2pkh(pub)
    if double_sha256(address.encode("ascii"))[:4] != address_hash:
        # Same address, but the key may have been stored as WIF by some tools.
        _ = encode_wif(privkey, compressed)
        return False
    return True


def decrypt_bip38(record: Bip38Record | str, passphrase: str) -> tuple[bytes, bool] | None:
    """Attempt to decrypt a BIP-38 key.

    Returns ``(privkey_bytes, compressed)`` when the passphrase is correct and
    the derived key reproduces the address hash embedded in the record, and
    ``None`` otherwise.
    """
    if isinstance(record, str):
        record = parse_bip38(record)

    password = _nfc(passphrase)

    if not record.ec_multiplied:
        derived = _scrypt(password, record.address_hash, *SCRYPT_PARAMS_HARD, 64)
        derived1, derived2 = derived[:32], derived[32:]
        aes = AES256ECB(derived2)
        decrypted = aes.decrypt_block(record.encrypted[0:16]) + aes.decrypt_block(record.encrypted[16:32])
        key = bytes(a ^ b for a, b in zip(decrypted, derived1))
        candidate = int.from_bytes(key, "big")
        if not is_valid_privkey(candidate):
            return None
        if not _check_address_hash(candidate, record.compressed, record.address_hash):
            return None
        return key, record.compressed

    # --- EC-multiplied -----------------------------------------------------
    owner_entropy = record.owner_entropy
    if record.has_lot_sequence:
        ownersalt = owner_entropy[:4]
        prefactor = _scrypt(password, ownersalt, *SCRYPT_PARAMS_HARD, 32)
        passfactor = int.from_bytes(sha256(sha256(prefactor + owner_entropy)), "big")
    else:
        # "Intermediate code" case: the 8 byte owner entropy is the salt and the
        # scrypt output is used directly as the passfactor (BIP-38 lines 134-135).
        passfactor = int.from_bytes(_scrypt(password, owner_entropy, *SCRYPT_PARAMS_HARD, 32), "big")

    passfactor %= N
    if not is_valid_privkey(passfactor):
        return None
    passpoint = pubkey_from_privkey(passfactor, True)

    derived = _scrypt(passpoint, record.address_hash + owner_entropy, *SCRYPT_PARAMS_SOFT, 64)
    derived1, derived2 = derived[:32], derived[32:]
    aes = AES256ECB(derived2)

    encrypted = record.encrypted
    part1, part2 = encrypted[:8], encrypted[8:]

    decrypted2 = aes.decrypt_block(part2)
    xor1 = bytes(a ^ b for a, b in zip(decrypted2, derived1[16:]))
    higher_part1 = xor1[:8]
    seed_b_high = xor1[8:]

    decrypted1 = aes.decrypt_block(part1 + higher_part1)
    seed_b_low = bytes(a ^ b for a, b in zip(decrypted1, derived1[:16]))

    seedb = seed_b_low + seed_b_high
    factorb = int.from_bytes(sha256(sha256(seedb)), "big")
    candidate = (passfactor * factorb) % N
    if not is_valid_privkey(candidate):
        return None
    if not _check_address_hash(candidate, record.compressed, record.address_hash):
        return None
    return candidate.to_bytes(32, "big"), record.compressed
