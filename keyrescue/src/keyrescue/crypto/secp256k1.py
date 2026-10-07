"""secp256k1 operations needed for key recovery.

The public interface is deliberately small -- derive a public key from a
private key, parse/serialise points and add a tweak -- because that is all the
recovery engines ever do.

``coincurve`` (libsecp256k1) is used when installed and is roughly 40x faster
than the pure Python fallback, which keeps the tool usable on machines where
binary wheels are unavailable (air-gapped recovery boxes, unusual platforms).
"""

from __future__ import annotations


from ..backends import prefer_pure_python
from ..errors import BackendError, InvalidInput

__all__ = [
    "P",
    "N",
    "G",
    "BACKEND",
    "is_valid_privkey",
    "pubkey_from_privkey",
    "hash160_variants",
    "parse_pubkey",
    "serialize_point",
    "point_add",
    "point_mul",
    "tweak_add_g",
    "xonly",
]

# Curve parameters (SEC 2 / secp256k1).
P = 0xFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFEFFFFFC2F
N = 0xFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFEBAAEDCE6AF48A03BBFD25E8CD0364141
G = (
    0x79BE667EF9DCBBAC55A06295CE870B07029BFCDB2DCE28D959F2815B16F81798,
    0x483ADA7726A3C4655DA4FBFC0E1108A8FD17B448A68554199C47D08FFB10D4B8,
)

BACKEND = "python"
try:  # pragma: no cover - depends on the environment
    import coincurve as _coincurve  # type: ignore

    BACKEND = "coincurve"
except Exception:  # pragma: no cover
    _coincurve = None

if prefer_pure_python():
    # QA switch: run the stdlib implementation even when a faster one is present,
    # so the fallback that bare installs use is exercised on every machine.
    BACKEND = "python"
    _coincurve = None


# --------------------------------------------------------------------------
# Pure Python fallback (Jacobian coordinates + small generator table)
# --------------------------------------------------------------------------

_G_TABLE: list[tuple[int, int] | None] = []


def _jacobian_double(pt):
    x, y, z = pt
    if y == 0:
        return (0, 0, 0)
    ysq = (y * y) % P
    s = (4 * x * ysq) % P
    m = (3 * x * x) % P
    nx = (m * m - 2 * s) % P
    ny = (m * (s - nx) - 8 * ysq * ysq) % P
    nz = (2 * y * z) % P
    return (nx, ny, nz)


def _jacobian_add(p1, p2):
    x1, y1, z1 = p1
    x2, y2, z2 = p2
    if z1 == 0:
        return p2
    if z2 == 0:
        return p1
    z1sq = (z1 * z1) % P
    z2sq = (z2 * z2) % P
    u1 = (x1 * z2sq) % P
    u2 = (x2 * z1sq) % P
    s1 = (y1 * z2sq % P * z2) % P
    s2 = (y2 * z1sq % P * z1) % P
    if u1 == u2:
        if s1 != s2:
            return (0, 0, 0)
        return _jacobian_double((x1, y1, z1))
    h = (u2 - u1) % P
    r = (s2 - s1) % P
    h2 = (h * h) % P
    h3 = (h2 * h) % P
    u1h2 = (u1 * h2) % P
    nx = (r * r - h3 - 2 * u1h2) % P
    ny = (r * (u1h2 - nx) - s1 * h3) % P
    nz = (h * z1 % P * z2) % P
    return (nx, ny, nz)


def _to_affine(pt):
    x, y, z = pt
    if z == 0:
        raise InvalidInput("point at infinity has no affine representation")
    zinv = pow(z, P - 2, P)
    zinv2 = (zinv * zinv) % P
    return ((x * zinv2) % P, (y * zinv2 % P * zinv) % P)


def _to_jacobian(pt):
    return (pt[0], pt[1], 1)


def _build_table():
    """4-bit window table for k*G, built lazily."""
    if _G_TABLE:
        return
    table: list[tuple[int, int] | None] = [None] * 16
    table[1] = G
    for i in range(2, 16):
        table[i] = _to_affine(_jacobian_add(_to_jacobian(table[i - 1]), _to_jacobian(G)))
    base16 = _jacobian_double(_jacobian_double(_jacobian_double(_jacobian_double(_to_jacobian(G)))))
    _G_TABLE.append(table)  # type: ignore[arg-type]
    _G_TABLE.append(base16)  # type: ignore[arg-type]


def _mul_g_py(k: int) -> tuple[int, int]:
    """Fixed 4-bit window multiplication of G (left to right).

    ``result = 16*result + digit*G`` per nibble, using the lazily built table for
    ``digit*G``.  Starting from the most significant nibble means the identity
    element is never doubled, and no per-digit scaling of the table is needed.
    """
    k %= N
    if k == 0:
        raise InvalidInput("private key must be between 1 and n-1")
    _build_table()
    table = _G_TABLE[0]  # type: ignore[index]
    nibbles = (k.bit_length() + 3) // 4
    top = (k >> (4 * (nibbles - 1))) & 0xF
    result = _to_jacobian(table[top])
    for index in range(nibbles - 2, -1, -1):
        for _ in range(4):
            result = _jacobian_double(result)
        digit = (k >> (4 * index)) & 0xF
        if digit:
            result = _jacobian_add(result, _to_jacobian(table[digit]))
    return _to_affine(result)


def _mul_py(k: int, pt: tuple[int, int]) -> tuple[int, int]:
    k %= N
    result = (0, 0, 0)
    addend = _to_jacobian(pt)
    while k:
        if k & 1:
            result = _jacobian_add(result, addend)
        addend = _jacobian_double(addend)
        k >>= 1
    return _to_affine(result)


def is_valid_privkey(k: int) -> bool:
    return isinstance(k, int) and 1 <= k < N


def point_add(p1: tuple[int, int], p2: tuple[int, int]) -> tuple[int, int]:
    if BACKEND == "coincurve":
        a = _coincurve.PublicKey(_serialize(p1, True))
        b = _coincurve.PublicKey(_serialize(p2, True))
        return parse_pubkey(a.combine([b]).format(True))
    return _to_affine(_jacobian_add(_to_jacobian(p1), _to_jacobian(p2)))


def point_mul(k: int, pt: tuple[int, int]) -> tuple[int, int]:
    if not is_valid_privkey(k % N or N):
        raise InvalidInput("scalar out of range")
    if pt == G:
        return _mul_g(k)
    if BACKEND == "coincurve":
        pub = _coincurve.PublicKey(_serialize(pt, True))
        multiplied = pub.multiply((k % N).to_bytes(32, "big"))
        return parse_pubkey(multiplied.format(True))
    return _mul_py(k, pt)


def _mul_g(k: int) -> tuple[int, int]:
    if BACKEND == "coincurve":
        secret = (k % N).to_bytes(32, "big")
        pub = _coincurve.PublicKey.from_valid_secret(secret)
        return parse_pubkey(pub.format(True))
    return _mul_g_py(k)


# --------------------------------------------------------------------------
# Serialisation helpers
# --------------------------------------------------------------------------


def _serialize(pt: tuple[int, int], compressed: bool) -> bytes:
    x, y = pt
    if compressed:
        return bytes([0x02 + (y & 1)]) + x.to_bytes(32, "big")
    return b"\x04" + x.to_bytes(32, "big") + y.to_bytes(32, "big")


def serialize_point(pt: tuple[int, int], compressed: bool = True) -> bytes:
    return _serialize(pt, compressed)


def parse_pubkey(data: bytes) -> tuple[int, int]:
    """Parse a 33 or 65 byte public key, validating it lies on the curve."""
    if len(data) == 33 and data[0] in (0x02, 0x03):
        x = int.from_bytes(data[1:], "big")
        alpha = (pow(x, 3, P) + 7) % P
        beta = pow(alpha, (P + 1) // 4, P)
        if (beta * beta) % P != alpha:
            raise InvalidInput("public key is not on the secp256k1 curve")
        y = beta if (beta & 1) == (data[0] & 1) else P - beta
        return (x, y)
    if len(data) == 65 and data[0] == 0x04:
        x = int.from_bytes(data[1:33], "big")
        y = int.from_bytes(data[33:], "big")
        if (y * y - (x * x * x + 7)) % P != 0:
            raise InvalidInput("public key is not on the secp256k1 curve")
        return (x, y)
    if len(data) == 32:  # raw x-only (BIP-340); assume even y
        x = int.from_bytes(data, "big")
        alpha = (pow(x, 3, P) + 7) % P
        beta = pow(alpha, (P + 1) // 4, P)
        if (beta * beta) % P != alpha:
            raise InvalidInput("x-only public key is not on the secp256k1 curve")
        return (x, min(beta, P - beta))
    raise InvalidInput("unrecognised public key encoding")


def pubkey_from_privkey(priv, compressed: bool = True) -> bytes:
    """Derive the serialised public key for a private key (int or 32 bytes)."""
    k = int.from_bytes(priv, "big") if isinstance(priv, (bytes, bytearray)) else priv
    if not is_valid_privkey(k):
        raise InvalidInput("private key is not a valid secp256k1 scalar")
    if BACKEND == "coincurve":
        # this is the hot path of every address-driven mode: hand the scalar to
        # libsecp256k1 and take its serialisation directly, instead of going
        # through a point (the parse round trip alone costs more than the tweak)
        return _coincurve.PublicKey.from_valid_secret(k.to_bytes(32, "big")).format(compressed)
    return _serialize(_mul_g(k), compressed)


def hash160_variants(priv) -> tuple[bytes, bytes]:
    """``(hash160(compressed pubkey), hash160(uncompressed pubkey))`` in one derivation.

    Both encodings of the same point are needed to match a P2PKH address, and the
    compressed form is just a parity byte plus the x coordinate, so one point
    multiplication and one extra hash is enough.
    """
    from .hashes import hash160

    k = int.from_bytes(priv, "big") if isinstance(priv, (bytes, bytearray)) else priv
    if not is_valid_privkey(k):
        raise InvalidInput("private key is not a valid secp256k1 scalar")
    if BACKEND == "coincurve":
        uncompressed = _coincurve.PublicKey.from_valid_secret(k.to_bytes(32, "big")).format(False)
        compressed = bytes([0x02 + (uncompressed[-1] & 1)]) + uncompressed[1:33]
        return hash160(compressed), hash160(uncompressed)
    point = _mul_g(k)
    return hash160(_serialize(point, True)), hash160(_serialize(point, False))


def hash160_pubkey(priv, compressed: bool = True) -> bytes:
    """HASH160 of the public key of ``priv`` -- the hot path in recovery loops."""
    from .hashes import hash160

    return hash160(pubkey_from_privkey(priv, compressed))


def xonly(pt: tuple[int, int]) -> bytes:
    """BIP-340 x-only encoding of a point."""
    return pt[0].to_bytes(32, "big")


def tweak_add_g(pt: tuple[int, int], tweak: int) -> tuple[int, int]:
    """Return ``pt + tweak*G`` (used for the BIP-341 TapTweak output key)."""
    if not 0 <= tweak < N:
        raise InvalidInput("tweak out of range")
    if tweak == 0:
        return pt
    return point_add(pt, _mul_g(tweak))


def ensure_backend() -> None:
    """Raise when no usable backend exists (never happens: pure Python is fine)."""
    if BACKEND not in ("coincurve", "python"):
        raise BackendError("no secp256k1 backend available")
