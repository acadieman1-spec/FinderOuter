"""Hash primitives, checked against the published reference vectors.

RIPEMD-160 is the only primitive KeyRescue implements itself (everything else
comes from :mod:`hashlib`), and it is implemented twice -- once accelerated and
once in pure Python for builds without that support -- so both paths are tested.
"""

from __future__ import annotations

import hashlib
import hmac as _hmac

import pytest

from keyrescue.crypto import hashes

# The reference vectors from the original RIPEMD-160 paper (Dobbertin, Bosselaers,
# Preneel), as also used by the OpenSSL test suite.
RIPEMD160_VECTORS = [
    ("", "9c1185a5c5e9fc54612808977ee8f548b2258d31"),
    ("a", "0bdc9d2d256b3ee9daae347be6f4dc835a467ffe"),
    ("abc", "8eb208f7e05d987a9b044a8e98c6b087f15a0bfc"),
    ("message digest", "5d0689ef49d2fae572b881b123a85ffa21595f36"),
    ("abcdefghijklmnopqrstuvwxyz", "f71c27109c692c1b56bbdceb5b9d2865b3708dbc"),
    (
        "abcdbcdecdefdefgefghfghighijhijkijkljklmklmnlmnomnopnopq",
        "12a053384a9c0c88e405a06c27dcf49ada62eb2b",
    ),
    (
        "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789",
        "b0e20b6e3116640286ed3a87a5713079b21f5189",
    ),
    ("1234567890" * 8, "9b752e45573d4b39f4dbd3323cab82bf63326bfb"),
]


@pytest.mark.parametrize("text,expected", RIPEMD160_VECTORS)
def test_ripemd160(text, expected):
    assert hashes.ripemd160(text.encode()).hex() == expected


@pytest.mark.parametrize("text,expected", RIPEMD160_VECTORS)
def test_ripemd160_pure_python_fallback(text, expected):
    """The fallback used when no accelerated implementation is present."""
    assert hashes._ripemd160_py(text.encode()).hex() == expected


def test_both_ripemd160_paths_agree():
    for size in (0, 1, 55, 56, 63, 64, 65, 119, 120, 4096):
        data = bytes(range(256)) * (size // 256 + 1)
        data = data[:size]
        assert hashes.ripemd160(data) == hashes._ripemd160_py(data)


def test_hash160_is_sha256_then_ripemd160():
    data = b"the quick brown fox"
    expected = hashes.ripemd160(hashlib.sha256(data).digest())
    assert hashes.hash160(data) == expected


def test_double_sha256():
    data = b"0123456789"
    once = hashlib.sha256(data).digest()
    assert hashes.double_sha256(data) == hashlib.sha256(once).digest()


def test_sha512_and_hmac_match_hashlib():
    assert hashes.sha512(b"abc") == hashlib.sha512(b"abc").digest()
    assert hashes.hmac_sha256(b"key", b"msg") == _hmac.new(b"key", b"msg", hashlib.sha256).digest()
    assert hashes.hmac_sha512(b"key", b"msg") == _hmac.new(b"key", b"msg", hashlib.sha512).digest()


def test_pbkdf2_matches_hashlib():
    assert hashes.pbkdf2_hmac_sha512(b"password", b"salt", 2048) == hashlib.pbkdf2_hmac(
        "sha512", b"password", b"salt", 2048, 64
    )
    assert hashes.pbkdf2_hmac_sha512(b"password", b"salt", 2048, dklen=32) == hashlib.pbkdf2_hmac(
        "sha512", b"password", b"salt", 2048, 32
    )
    assert hashes.pbkdf2_hmac_sha256(b"password", b"salt", 1000) == hashlib.pbkdf2_hmac(
        "sha256", b"password", b"salt", 1000, 32
    )


def test_tagged_hash_follows_bip341_definition():
    """BIP-341: SHA256(SHA256(tag) || SHA256(tag) || message)."""
    tag, message = b"TapTweak", b"\x01" * 32
    inner = hashlib.sha256(tag).digest()
    expected = hashlib.sha256(inner + inner + message).digest()
    assert hashes.tagged_hash("TapTweak", message) == expected


def test_p2pkh_hash160_of_public_key_one():
    """The hash160 that BIP-173 publishes for the private key 1."""
    from keyrescue.crypto.secp256k1 import pubkey_from_privkey

    pub = pubkey_from_privkey(1, True)
    assert hashes.hash160(pub).hex() == "751e76e8199196d454941c45d1b3a323f1433bd6"
