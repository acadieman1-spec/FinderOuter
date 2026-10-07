"""Pure Python Ed25519 (RFC 8032).

KeyRescue verifies license keys offline, on machines that may not have any
cryptographic library beyond the standard one, so Ed25519 is implemented here
directly from the RFC.  The signing half is used by the vendor key generator
(``tools/keygen.py``) and by the test suite.
"""

from __future__ import annotations

import hashlib

__all__ = ["publickey", "sign", "verify", "create_keypair", "SEED_SIZE"]

P = 2**255 - 19
Q = 2**252 + 27742317777372353535851937790883648493
SEED_SIZE = 32
_D = -121665 * pow(121666, P - 2, P) % P
_I = pow(2, (P - 1) // 4, P)


def _sha512(data: bytes) -> bytes:
    return hashlib.sha512(data).digest()


def _inv(x: int) -> int:
    return pow(x, P - 2, P)


def _x_recover(y: int) -> int:
    xx = (y * y - 1) * _inv(_D * y * y + 1)
    x = pow(xx, (P + 3) // 8, P)
    if (x * x - xx) % P != 0:
        x = (x * _I) % P
    if x % 2 != 0:
        x = P - x
    return x


_BY = 4 * _inv(5) % P
_BX = _x_recover(_BY)
_B = (_BX % P, _BY % P, 1, (_BX * _BY) % P)


def _edwards_add(p, q):
    x1, y1, z1, t1 = p
    x2, y2, z2, t2 = q
    a = (y1 - x1) * (y2 - x2) % P
    b = (y1 + x1) * (y2 + x2) % P
    c = t1 * 2 * _D * t2 % P
    dd = z1 * 2 * z2 % P
    e, f, g, h = b - a, dd - c, dd + c, b + a
    return (e * f % P, g * h % P, f * g % P, e * h % P)


def _scalar_mult(p, e: int):
    if e == 0:
        return (0, 1, 1, 0)
    q = _scalar_mult(p, e // 2)
    q = _edwards_add(q, q)
    if e & 1:
        q = _edwards_add(q, p)
    return q


def _encode_point(p) -> bytes:
    x, y, z, _ = p
    zi = _inv(z)
    x = x * zi % P
    y = y * zi % P
    bits = [(y >> i) & 1 for i in range(255)] + [x & 1]
    return bytes(sum(bits[i * 8 + j] << j for j in range(8)) for i in range(32))


def _decode_point(data: bytes):
    if len(data) != 32:
        raise ValueError("point must be 32 bytes")
    y = int.from_bytes(data, "little") & (2**255 - 1)
    sign = data[31] >> 7
    x = _x_recover(y)
    if x & 1 != sign:
        x = P - x
    point = (x, y, 1, x * y % P)
    if not _is_on_curve(point):
        raise ValueError("point is not on the curve")
    return point


def _is_on_curve(p) -> bool:
    x, y, z, t = p
    if z % P == 0:
        return x == 0 and y == z
    return (-x * x + y * y - z * z - _D * t * t) % P == 0


def _sha512_mod_q(data: bytes) -> int:
    return int.from_bytes(_sha512(data), "little") % Q


def create_keypair(seed: bytes | None = None) -> tuple[bytes, bytes]:
    """Return ``(32 byte private seed, 32 byte public key)``."""
    import os

    seed = seed or os.urandom(SEED_SIZE)
    if len(seed) != SEED_SIZE:
        raise ValueError("seed must be 32 bytes")
    return seed, publickey(seed)


def publickey(seed: bytes) -> bytes:
    h = _sha512(seed)
    a = 2**254 + sum(2**i * ((h[i // 8] >> (i % 8)) & 1) for i in range(3, 254))
    return _encode_point(_scalar_mult(_B, a))


def sign(message: bytes, seed: bytes, public: bytes | None = None) -> bytes:
    """RFC 8032 Ed25519 signature (64 bytes)."""
    public = public or publickey(seed)
    h = _sha512(seed)
    a = 2**254 + sum(2**i * ((h[i // 8] >> (i % 8)) & 1) for i in range(3, 254))
    prefix = h[32:]
    r = _sha512_mod_q(prefix + message)
    r_point = _scalar_mult(_B, r)
    s = (r + _sha512_mod_q(_encode_point(r_point) + public + message) * a) % Q
    return _encode_point(r_point) + s.to_bytes(32, "little")


def verify(signature: bytes, message: bytes, public: bytes) -> bool:
    """Verify an Ed25519 signature, returning True/False (never raising)."""
    if len(signature) != 64 or len(public) != 32:
        return False
    try:
        r_point = _decode_point(signature[:32])
        a_point = _decode_point(public)
    except ValueError:
        return False
    s = int.from_bytes(signature[32:], "little")
    if s >= Q:
        return False
    expected = _scalar_mult(_B, s)
    h = _sha512_mod_q(signature[:32] + public + message)
    actual = _edwards_add(r_point, _scalar_mult(a_point, h))
    if not _is_on_curve(actual):
        return False
    return _encode_point(expected) == _encode_point(actual)
