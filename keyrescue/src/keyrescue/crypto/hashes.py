"""Hash primitives used across KeyRescue.

All hashes are byte oriented and return ``bytes``.  The module prefers the
fastest available implementation and always keeps a self-contained pure Python
fallback so the package works on a bare interpreter (e.g. an air-gapped
machine with no wheels available).

Backends, in order of preference:

1. ``hashlib`` (OpenSSL) for sha256/sha512/hmac/pbkdf2 -- always present.
2. ``hashlib.new("ripemd160")`` when OpenSSL still ships the legacy provider.
3. ``pycryptodome`` when installed.
4. Pure Python implementations (this module).

Only the RIPEMD-160 fallback is realistically reachable on modern systems,
everything else uses OpenSSL.
"""

from __future__ import annotations

from ..backends import prefer_pure_python

import hashlib
import hmac as _hmac

__all__ = [
    "sha256",
    "double_sha256",
    "sha512",
    "ripemd160",
    "hash160",
    "hmac_sha256",
    "hmac_sha512",
    "pbkdf2_hmac_sha512",
    "pbkdf2_hmac_sha256",
    "tagged_hash",
    "HAS_ACCELERATED_RIPEMD160",
]


def sha256(data: bytes) -> bytes:
    """Single SHA-256."""
    return hashlib.sha256(data).digest()


def double_sha256(data: bytes) -> bytes:
    """SHA-256 applied twice (Bitcoin's ``Hash()``)."""
    return hashlib.sha256(hashlib.sha256(data).digest()).digest()


def sha512(data: bytes) -> bytes:
    """Single SHA-512."""
    return hashlib.sha512(data).digest()


def hmac_sha256(key: bytes, data: bytes) -> bytes:
    return _hmac.new(key, data, hashlib.sha256).digest()


def hmac_sha512(key: bytes, data: bytes) -> bytes:
    return _hmac.new(key, data, hashlib.sha512).digest()


def pbkdf2_hmac_sha512(password: bytes, salt: bytes, iterations: int, dklen: int = 64) -> bytes:
    return hashlib.pbkdf2_hmac("sha512", password, salt, iterations, dklen)


def pbkdf2_hmac_sha256(password: bytes, salt: bytes, iterations: int, dklen: int = 32) -> bytes:
    return hashlib.pbkdf2_hmac("sha256", password, salt, iterations, dklen)


def tagged_hash(tag: str, data: bytes) -> bytes:
    """BIP-340 style tagged hash (used by Taproot/BIP-32 variants)."""
    tag_hash = sha256(tag.encode())
    return sha256(tag_hash + tag_hash + data)


# ---------------------------------------------------------------------------
# RIPEMD-160
# ---------------------------------------------------------------------------


def _load_accelerated_ripemd160():
    """Return a callable implementing RIPEMD-160, or ``None``."""
    if prefer_pure_python():  # see keyrescue.backends
        return None
    try:  # OpenSSL with legacy provider enabled
        hashlib.new("ripemd160", b"").digest()
        return lambda data: hashlib.new("ripemd160", data).digest()
    except Exception:
        pass
    try:  # pycryptodome, when present
        from Crypto.Hash import RIPEMD160  # type: ignore

        return lambda data: RIPEMD160.new(data).digest()
    except Exception:
        return None


# --- pure Python RIPEMD-160 (RFC 2286 reference-ish implementation) --------

_RL = [
    0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15,
    7, 4, 13, 1, 10, 6, 15, 3, 12, 0, 9, 5, 2, 14, 11, 8,
    3, 10, 14, 4, 9, 15, 8, 1, 2, 7, 0, 6, 13, 11, 5, 12,
    1, 9, 11, 10, 0, 8, 12, 4, 13, 3, 7, 15, 14, 5, 6, 2,
    4, 0, 5, 9, 7, 12, 2, 10, 14, 1, 3, 8, 11, 6, 15, 13,
]
_RR = [
    5, 14, 7, 0, 9, 2, 11, 4, 13, 6, 15, 8, 1, 10, 3, 12,
    6, 11, 3, 7, 0, 13, 5, 10, 14, 15, 8, 12, 4, 9, 1, 2,
    15, 5, 1, 3, 7, 14, 6, 9, 11, 8, 12, 2, 10, 0, 4, 13,
    8, 6, 4, 1, 3, 11, 15, 0, 5, 12, 2, 13, 9, 7, 10, 14,
    12, 15, 10, 4, 1, 5, 8, 7, 6, 2, 13, 14, 0, 3, 9, 11,
]
_SL = [
    11, 14, 15, 12, 5, 8, 7, 9, 11, 13, 14, 15, 6, 7, 9, 8,
    7, 6, 8, 13, 11, 9, 7, 15, 7, 12, 15, 9, 11, 7, 13, 12,
    11, 13, 6, 7, 14, 9, 13, 15, 14, 8, 13, 6, 5, 12, 7, 5,
    11, 12, 14, 15, 14, 15, 9, 8, 9, 14, 5, 6, 8, 6, 5, 12,
    9, 15, 5, 11, 6, 8, 13, 12, 5, 12, 13, 14, 11, 8, 5, 6,
]
_SR = [
    8, 9, 9, 11, 13, 15, 15, 5, 7, 7, 8, 11, 14, 14, 12, 6,
    9, 13, 15, 7, 12, 8, 9, 11, 7, 7, 12, 7, 6, 15, 13, 11,
    9, 7, 15, 11, 8, 6, 6, 14, 12, 13, 5, 14, 13, 13, 7, 5,
    15, 5, 8, 11, 14, 14, 6, 14, 6, 9, 12, 9, 12, 5, 15, 8,
    8, 5, 12, 9, 12, 5, 14, 6, 8, 13, 6, 5, 15, 13, 11, 11,
]
_KL = [0x00000000, 0x5A827999, 0x6ED9EBA1, 0x8F1BBCDC, 0xA953FD4E]
_KR = [0x50A28BE6, 0x5C4DD124, 0x6D703EF3, 0x7A6D76E9, 0x00000000]


def _rol(x: int, n: int) -> int:
    """Rotate the bottom 32 bits of ``x`` left by ``n`` bits."""
    x &= 0xFFFFFFFF
    return ((x << n) | (x >> (32 - n))) & 0xFFFFFFFF


def _ripemd160_py(message: bytes) -> bytes:
    h0, h1, h2, h3, h4 = 0x67452301, 0xEFCDAB89, 0x98BADCFE, 0x10325476, 0xC3D2E1F0
    length = len(message)
    message += b"\x80" + b"\x00" * ((55 - length) % 64) + (length * 8).to_bytes(8, "little")

    for offset in range(0, len(message), 64):
        x = [int.from_bytes(message[offset + 4 * i : offset + 4 * i + 4], "little") for i in range(16)]
        al, bl, cl, dl, el = h0, h1, h2, h3, h4
        ar, br, cr, dr, er = h0, h1, h2, h3, h4

        for j in range(80):
            rnd = j // 16
            # f(j) is evaluated on (B, C, D); the right line uses the mirrored functions
            # (f5, f4, f3, f2, f1) on its own (B', C', D') triple.
            if rnd == 0:
                f, k = bl ^ cl ^ dl, _KL[0]
                fr, kr = br ^ (cr | ~dr), _KR[0]
            elif rnd == 1:
                f, k = (bl & cl) | (~bl & dl), _KL[1]
                fr, kr = (br & dr) | (cr & ~dr), _KR[1]
            elif rnd == 2:
                f, k = (bl | ~cl) ^ dl, _KL[2]
                fr, kr = (br | ~cr) ^ dr, _KR[2]
            elif rnd == 3:
                f, k = (bl & dl) | (cl & ~dl), _KL[3]
                fr, kr = (br & cr) | (~br & dr), _KR[3]
            else:
                f, k = bl ^ (cl | ~dl), _KL[4]
                fr, kr = br ^ cr ^ dr, _KR[4]

            t = (_rol((al + f + x[_RL[j]] + k) & 0xFFFFFFFF, _SL[j]) + el) & 0xFFFFFFFF
            al, el, dl, cl, bl = el, dl, _rol(cl, 10), bl, t

            t = (_rol((ar + fr + x[_RR[j]] + kr) & 0xFFFFFFFF, _SR[j]) + er) & 0xFFFFFFFF
            ar, er, dr, cr, br = er, dr, _rol(cr, 10), br, t

        t = (h1 + cl + dr) & 0xFFFFFFFF
        h1 = (h2 + dl + er) & 0xFFFFFFFF
        h2 = (h3 + el + ar) & 0xFFFFFFFF
        h3 = (h4 + al + br) & 0xFFFFFFFF
        h4 = (h0 + bl + cr) & 0xFFFFFFFF
        h0 = t

    return b"".join(v.to_bytes(4, "little") for v in (h0, h1, h2, h3, h4))


_accelerated_ripemd160 = _load_accelerated_ripemd160()
HAS_ACCELERATED_RIPEMD160 = _accelerated_ripemd160 is not None

if _accelerated_ripemd160 is not None:
    def ripemd160(data: bytes) -> bytes:
        return _accelerated_ripemd160(data)  # type: ignore[misc]
else:
    ripemd160 = _ripemd160_py  # type: ignore[assignment]


def hash160(data: bytes) -> bytes:
    """RIPEMD-160(SHA-256(data)) -- the standard Bitcoin ``Hash160``."""
    return ripemd160(sha256(data))
