"""Wallet Import Format (WIF) private keys."""

from __future__ import annotations

from dataclasses import dataclass

from ..errors import InvalidEncoding, InvalidInput
from . import base58
from .secp256k1 import N, is_valid_privkey

__all__ = ["WifInfo", "encode_wif", "decode_wif", "is_wif", "WIF_LENGTHS"]

PRIVATE_KEY_PREFIX = 0x80
COMPRESSED_SUFFIX = 0x01
# 51 chars when uncompressed, 52 when compressed (mainnet).
WIF_LENGTHS = (51, 52)


@dataclass(frozen=True)
class WifInfo:
    """A decoded WIF string."""

    privkey: bytes
    compressed: bool
    prefix: int
    text: str = ""

    @property
    def privkey_int(self) -> int:
        return int.from_bytes(self.privkey, "big")

    @property
    def hex(self) -> str:
        return self.privkey.hex()


def encode_wif(privkey: bytes | int, compressed: bool = True, prefix: int = PRIVATE_KEY_PREFIX) -> str:
    """Encode a 32 byte private key as WIF."""
    key = privkey.to_bytes(32, "big") if isinstance(privkey, int) else bytes(privkey)
    if len(key) != 32:
        raise InvalidInput("a private key is 32 bytes")
    payload = bytes([prefix]) + key + (bytes([COMPRESSED_SUFFIX]) if compressed else b"")
    return base58.b58check_encode(payload)


def decode_wif(text: str, prefixes: tuple[int, ...] = (PRIVATE_KEY_PREFIX,)) -> WifInfo:
    """Decode a WIF string, verifying the prefix, length and scalar range."""
    text = text.strip()
    payload = base58.b58check_decode(text)
    if len(payload) not in (33, 34):
        raise InvalidInput(f"WIF payload must be 33 or 34 bytes, got {len(payload)}")
    prefix = payload[0]
    if prefix not in prefixes:
        raise InvalidInput(f"unexpected WIF version byte 0x{prefix:02x}")

    if len(payload) == 34:
        if payload[-1] != COMPRESSED_SUFFIX:
            raise InvalidEncoding("compressed WIF must end with 0x01")
        compressed = True
        key = payload[1:33]
    else:
        compressed = False
        key = payload[1:33]

    if not is_valid_privkey(int.from_bytes(key, "big")):
        raise InvalidInput("WIF encodes an out-of-range private key")
    return WifInfo(key, compressed, prefix, text)


def is_wif(text: str) -> bool:
    """Cheap structural test used by input auto-detection."""
    text = text.strip()
    if not text or text[0] not in ("5", "K", "L", "9", "c"):
        return False
    try:
        decode_wif(text, prefixes=(PRIVATE_KEY_PREFIX, 0xEF))
        return True
    except Exception:
        return False


def wif_privkey_int(text: str) -> int:
    """Return the private key integer encoded in a WIF string."""
    info = decode_wif(text)
    value = info.privkey_int
    if not (1 <= value < N):
        raise InvalidInput("WIF private key is out of range")
    return value
