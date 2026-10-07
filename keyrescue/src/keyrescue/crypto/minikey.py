"""Mini private keys (Casascius "mini" format).

A mini private key is a short Base-58 string starting with ``S``:

* 30 characters -- the classic mini private key
* 22 or 26 characters -- shorter variants used on physical coins

The private key is ``SHA256(minikey)`` and the validity marker is a leading
zero byte in ``SHA256(minikey + "?")``.
"""

from __future__ import annotations

from ..errors import InvalidInput
from .hashes import sha256

__all__ = ["MINIKEY_LENGTHS", "is_minikey", "is_valid_minikey", "privkey_from_minikey", "minikey_info"]

MINIKEY_LENGTHS = (22, 26, 30)
MARKER = "?"
FIRST_CHAR = "S"


def is_minikey(text: str) -> bool:
    """Structural check: starts with ``S`` and has a supported length."""
    return bool(text) and text[0] == FIRST_CHAR and len(text) in MINIKEY_LENGTHS


def is_valid_minikey(text: str) -> bool:
    """Full validity check: first byte of ``SHA256(key + "?")`` must be zero."""
    if not is_minikey(text):
        return False
    return sha256(f"{text}{MARKER}".encode("ascii"))[0] == 0


def privkey_from_minikey(text: str) -> bytes:
    """Return the 32 byte private key encoded by a mini private key."""
    if not is_minikey(text):
        raise InvalidInput(
            f"a mini private key starts with 'S' and is one of {MINIKEY_LENGTHS} characters long"
        )
    return sha256(text.encode("ascii"))


def minikey_info(text: str) -> dict[str, object]:
    """Everything known about a mini private key (used by `keyrescue info`)."""
    if not is_minikey(text):
        raise InvalidInput("not a mini private key")
    private = privkey_from_minikey(text)
    return {
        "length": len(text),
        "valid_marker": is_valid_minikey(text),
        "privkey_hex": private.hex(),
        "privkey_wif_uncompressed": _wif(private, False),
        "privkey_wif_compressed": _wif(private, True),
    }


def _wif(key: bytes, compressed: bool) -> str:
    from .wif import encode_wif

    return encode_wif(key, compressed)
