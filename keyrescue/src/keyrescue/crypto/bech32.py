"""Bech32 / Bech32m (BIP-173 and BIP-350) and SegWit address handling."""

from __future__ import annotations

from ..errors import InvalidEncoding

__all__ = [
    "CHARSET",
    "bech32_encode",
    "bech32_decode",
    "encode_segwit_address",
    "decode_segwit_address",
    "convertbits",
]

CHARSET = "qpzry9x8gf2tvdw0s3jn54khce6mua7l"
_CHARSET_INDEX = {c: i for i, c in enumerate(CHARSET)}
_BECH32_CONST = 1
_BECH32M_CONST = 0x2BC830A3
_SEPARATOR = "1"


def _polymod(values: list[int]) -> int:
    generator = (0x3B6A57B2, 0x26508E6D, 0x1EA119FA, 0x3D4233DD, 0x2A1462B3)
    chk = 1
    for value in values:
        top = chk >> 25
        chk = ((chk & 0x1FFFFFF) << 5) ^ value
        for i in range(5):
            if (top >> i) & 1:
                chk ^= generator[i]
    return chk


def _hrp_expand(hrp: str) -> list[int]:
    return [ord(c) >> 5 for c in hrp] + [0] + [ord(c) & 31 for c in hrp]


def _create_checksum(hrp: str, data: list[int], spec: str) -> list[int]:
    const = _BECH32_CONST if spec == "bech32" else _BECH32M_CONST
    values = _hrp_expand(hrp) + data
    polymod = _polymod(values + [0, 0, 0, 0, 0, 0]) ^ const
    return [(polymod >> 5 * (5 - i)) & 31 for i in range(6)]


def _verify_checksum(hrp: str, data: list[int]) -> str | None:
    """Return 'bech32'/'bech32m' when the checksum verifies, otherwise None."""
    check = _polymod(_hrp_expand(hrp) + data)
    if check == _BECH32_CONST:
        return "bech32"
    if check == _BECH32M_CONST:
        return "bech32m"
    return None


def convertbits(data, from_bits: int, to_bits: int, pad: bool = True) -> list[int]:
    """General power-of-2 base conversion used by SegWit address encoding."""
    acc = 0
    bits = 0
    ret = []
    maxv = (1 << to_bits) - 1
    max_acc = (1 << (from_bits + to_bits - 1)) - 1
    for value in data:
        if value < 0 or (value >> from_bits):
            raise InvalidEncoding("invalid value for bit conversion")
        acc = ((acc << from_bits) | value) & max_acc
        bits += from_bits
        while bits >= to_bits:
            bits -= to_bits
            ret.append((acc >> bits) & maxv)
    if pad:
        if bits:
            ret.append((acc << (to_bits - bits)) & maxv)
    elif bits >= from_bits or ((acc << (to_bits - bits)) & maxv):
        raise InvalidEncoding("invalid padding in bit conversion")
    return ret


def bech32_encode(hrp: str, data: list[int], spec: str = "bech32") -> str:
    """Encode a Bech32/Bech32m string from 5-bit ``data`` symbols."""
    combined = data + _create_checksum(hrp, data, spec)
    return hrp + _SEPARATOR + "".join(CHARSET[d] for d in combined)


def bech32_decode(text: str) -> tuple[str, list[int], str]:
    """Decode and verify a Bech32/Bech32m string.

    Returns ``(hrp, data_without_checksum, spec)`` and raises
    :class:`InvalidEncoding` on any structural or checksum problem.
    """
    if not text:
        raise InvalidEncoding("empty Bech32 string")
    if any(ord(c) < 33 or ord(c) > 126 for c in text):
        raise InvalidEncoding("Bech32 string contains non-printable characters")
    if text.lower() != text and text.upper() != text:
        raise InvalidEncoding("Bech32 string mixes upper and lower case")

    text = text.lower()
    pos = text.rfind(_SEPARATOR)
    if pos < 1 or pos + 7 > len(text) or len(text) > 90:
        raise InvalidEncoding("invalid Bech32 separator position or length")

    hrp = text[:pos]
    if any(ord(c) < 33 or ord(c) > 126 for c in hrp):
        raise InvalidEncoding("invalid Bech32 human readable part")

    try:
        data = [_CHARSET_INDEX[c] for c in text[pos + 1 :]]
    except KeyError:
        raise InvalidEncoding("invalid Bech32 character") from None

    spec = _verify_checksum(hrp, data)
    if spec is None:
        raise InvalidEncoding("Bech32 checksum mismatch")
    return hrp, data[:-6], spec


def encode_segwit_address(hrp: str, witver: int, witprog: bytes) -> str:
    """Encode a SegWit address (BIP-173 for v0, BIP-350 for v1+)."""
    if not 0 <= witver <= 16:
        raise InvalidEncoding("witness version must be between 0 and 16")
    if not 2 <= len(witprog) <= 40:
        raise InvalidEncoding("witness program must be 2 to 40 bytes")
    if witver == 0 and len(witprog) not in (20, 32):
        raise InvalidEncoding("witness v0 program must be 20 or 32 bytes")
    spec = "bech32" if witver == 0 else "bech32m"
    data = [witver] + convertbits(witprog, 8, 5)
    return bech32_encode(hrp, data, spec)


def decode_segwit_address(text: str, expected_hrp: str | None = None) -> tuple[str, int, bytes]:
    """Decode a SegWit address, returning ``(hrp, witver, witprog)``."""
    hrp, data, spec = bech32_decode(text)
    if expected_hrp is not None and hrp != expected_hrp:
        raise InvalidEncoding(f"unexpected address prefix {hrp!r} (expected {expected_hrp!r})")
    if not data:
        raise InvalidEncoding("empty SegWit data section")

    witver = data[0]
    if not 0 <= witver <= 16:
        raise InvalidEncoding("invalid witness version")
    if spec == "bech32" and witver != 0:
        raise InvalidEncoding("witness v1+ requires Bech32m encoding")
    if spec == "bech32m" and witver == 0:
        raise InvalidEncoding("witness v0 requires Bech32 encoding")

    witprog = bytes(convertbits(data[1:], 5, 8, pad=False))
    if not 2 <= len(witprog) <= 40:
        raise InvalidEncoding("invalid witness program length")
    if witver == 0 and len(witprog) not in (20, 32):
        raise InvalidEncoding("witness v0 program must be 20 or 32 bytes")
    return hrp, witver, witprog
