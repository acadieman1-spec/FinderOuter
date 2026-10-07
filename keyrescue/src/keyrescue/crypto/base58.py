"""Base-58 and Base-58Check (Bitcoin's "Base58 with checksum") codecs."""

from __future__ import annotations

from ..errors import InvalidEncoding

__all__ = ["ALPHABET", "b58encode", "b58decode", "b58check_encode", "b58check_decode", "has_invalid_chars"]

ALPHABET = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz"
_INDEX = {c: i for i, c in enumerate(ALPHABET)}
_ZERO = ALPHABET[0]
_BASE = 58


def has_invalid_chars(text: str) -> str | None:
    """Return the first character of ``text`` that is not valid Base-58, or None."""
    for ch in text:
        if ch not in _INDEX:
            return ch
    return None


def b58encode(data: bytes) -> str:
    """Encode raw bytes as Base-58 (with leading zero bytes mapped to '1')."""
    zeros = len(data) - len(data.lstrip(b"\x00"))
    number = int.from_bytes(data, "big")
    out = []
    while number:
        number, rem = divmod(number, _BASE)
        out.append(ALPHABET[rem])
    return _ZERO * zeros + "".join(reversed(out))


def b58decode(text: str) -> bytes:
    """Decode a Base-58 string to raw bytes."""
    number = 0
    for ch in text:
        try:
            number = number * _BASE + _INDEX[ch]
        except KeyError:
            raise InvalidEncoding(f"invalid Base-58 character {ch!r}") from None
    body = number.to_bytes((number.bit_length() + 7) // 8, "big")
    zeros = len(text) - len(text.lstrip(_ZERO))
    return b"\x00" * zeros + body


def b58check_encode(payload: bytes, checksum_len: int = 4) -> str:
    """Base-58Check encode an already versioned payload."""
    from .hashes import double_sha256

    return b58encode(payload + double_sha256(payload)[:checksum_len])


def b58check_decode(text: str, checksum_len: int = 4) -> bytes:
    """Decode Base-58Check, verifying the trailing checksum. Returns the payload."""
    from .hashes import double_sha256

    data = b58decode(text)
    if len(data) < checksum_len:
        raise InvalidEncoding("input is too short to contain a checksum")
    payload, checksum = data[:-checksum_len], data[-checksum_len:]
    if double_sha256(payload)[:checksum_len] != checksum:
        raise InvalidEncoding("Base-58 checksum mismatch")
    return payload
