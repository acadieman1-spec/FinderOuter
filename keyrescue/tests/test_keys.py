"""Key derivation and the mnemonic/minikey formats.

BIP-32 vectors are the ones published in that BIP (both test vectors, every
chain in the tables, xprv *and* xpub).  BIP-39 vectors are the reference list
that the BIP points at.  The minikey vector is the sample from the Bitcoin Wiki.
"""

from __future__ import annotations

import pytest

from keyrescue.crypto import bip32, bip39, minikey
from keyrescue.crypto.addresses import p2pkh
from keyrescue.crypto.bip32 import derive_extended, derive_path_privkey, parse_extended_key, parse_path
from keyrescue.crypto.secp256k1 import N, is_valid_privkey
from keyrescue.crypto.wif import encode_wif
from keyrescue.errors import InvalidEncoding, InvalidInput

# ------------------------------------------------------------------------ BIP-32
def test_parse_path_notation():
    assert [c.value for c in parse_path("m")] == []
    assert [c.value for c in parse_path("m/0/1")] == [0, 1]
    assert [c.value for c in parse_path("m/44h/0h/0h")] == [44 + bip32.HARDENED, 0 + bip32.HARDENED,
                                                             0 + bip32.HARDENED]
    assert [c.value for c in parse_path("m/44'/0'/0'/0/0")] == [
        44 + bip32.HARDENED,
        bip32.HARDENED,
        bip32.HARDENED,
        0,
        0,
    ]
    assert bip32.path_to_string(parse_path("m/44'/0'/0'/0/0")) == "m/44h/0h/0h/0/0"
    with pytest.raises((InvalidInput, ValueError)):
        parse_path("m/44'/notanumber")
    with pytest.raises((InvalidInput, ValueError)):
        parse_path("44'/0'")


def test_bip32_master_and_children(bip32_vectors):
    for number, vector in enumerate(bip32_vectors["vectors"], 1):
        seed = bytes.fromhex(vector["seed"])
        for row in vector["rows"]:
            extended = derive_extended(seed, row["path"])
            assert extended.serialize() == row["xprv"], f"vector {number} {row['path']} xprv"
            public = derive_extended(seed, row["path"], private=False)
            assert public.serialize() == row["xpub"], f"vector {number} {row['path']} xpub"


def test_bip32_extended_key_parsing(bip32_vectors):
    """A parse/serialize round trip, using the BIP-32 table as ground truth."""
    row = bip32_vectors["vectors"][0]["rows"][3]          # m/0'/1/2'
    parsed = parse_extended_key(row["xprv"])
    assert parsed.private is True
    assert parsed.depth == 3
    assert parsed.child_number == 2 + bip32.HARDENED
    assert len(parsed.chaincode) == 32
    assert parsed.serialize() == row["xprv"]
    public = parse_extended_key(row["xpub"])
    assert public.private is False and public.serialize() == row["xpub"]
    # an xpub carries a point, not a scalar, and serialising it must not need one
    assert public.pubkey == derive_extended(bytes.fromhex(
        bip32_vectors["vectors"][0]["seed"]), row["path"], private=False).pubkey
    for corrupt in (row["xprv"][:-1] + "A", row["xpub"][:-2] + "zz", "xprv" + "0" * 100):
        with pytest.raises((InvalidInput, InvalidEncoding)):
            parse_extended_key(corrupt)


def test_bip32_hardened_child_of_zero_matches_spec(bip32_vectors):
    """The famous first hardened child of test vector 1."""
    seed = bytes.fromhex(bip32_vectors["vectors"][0]["seed"])
    expected = "xprv9uHRZZhk6KAJC1avXpDAp4MDc3sQKNxDiPvvkX8Br5ngLNv1TxvUxt4cV1rGL5hj6KCesnDYUhd7oWgT11eZG7XnxHrnYeSvkzY7d2bhkJ7"
    assert derive_extended(seed, "m/0'").serialize() == expected


def test_derive_path_privkey_matches_extended(bip32_vectors):
    seed = bytes.fromhex(bip32_vectors["vectors"][1]["seed"])
    path = "m/0/2147483647'/1"
    assert derive_extended(seed, path).key == derive_path_privkey(seed, path)


def test_bip39_wordlist_and_helpers():
    words = bip39.load_wordlist("english")
    assert words.size == 2048
    assert words.bits_per_word == 11
    assert words.index_of("abandon") == 0
    assert words.index_of("zoo") == 2047
    with pytest.raises(InvalidInput):
        words.index_of("not-a-bip39-word")
    # the cached map must be the same object, i.e. built once
    assert words._index_map() is words._index_map()
    assert "english" in bip39.available_wordlists("bip39")


def test_electrum_and_bip39_share_the_english_words():
    """Electrum 2.x reuses the BIP-39 English list; only the scheme differs.

    See ``src/keyrescue/data/wordlists/README.md``.  A mnemonic is therefore a
    valid *word sequence* for both schemes, and the distinction that matters is
    the PBKDF2 salt prefix and the checksum rule.
    """
    electrum = bip39.load_wordlist("english", kind="electrum")
    bip39_list = bip39.load_wordlist("english", kind="bip39")
    assert electrum.kind == "electrum" and bip39_list.kind == "bip39"
    assert electrum.words == bip39_list.words
    assert electrum.size == bip39_list.size == 2048


# ------------------------------------------------------------------------ BIP-39
def test_bip39_vectors(bip39_vectors):
    passphrase = bip39_vectors["passphrase"]
    for entry in bip39_vectors["vectors"]:
        mnemonic = entry["mnemonic"]
        assert bip39.mnemonic_to_seed(mnemonic, passphrase).hex() == entry["seed"]
        assert bip39.mnemonic_to_entropy(mnemonic).hex() == entry["entropy"]
        assert bip39.entropy_to_mnemonic(bytes.fromhex(entry["entropy"])) == mnemonic
        assert bip39.validate_bip39(mnemonic)[0] is True


def test_bip39_bad_checksum_is_reported(bip39_vectors):
    good = bip39_vectors["vectors"][0]["mnemonic"]
    broken = good.rsplit(" ", 1)[0] + " abandon"
    ok, reason = bip39.validate_bip39(broken)
    assert ok is False
    assert "checksum" in reason.lower()


def test_bip39_rejects_unknown_words_and_lengths(bip39_vectors):
    good = bip39_vectors["vectors"][0]["mnemonic"]
    with pytest.raises(InvalidInput, match="not in the english"):
        bip39.mnemonic_to_entropy(good.rsplit(" ", 1)[0] + " notaword")
    with pytest.raises(InvalidInput, match="12, 15, 18, 21 or 24"):
        bip39.mnemonic_to_entropy("abandon abandon abandon")


def test_bip39_seed_derivation_is_lenient_by_design(bip39_vectors):
    """A non-BIP-39 string still derives a seed (wallets accept this).

    Only ``mnemonic_to_entropy`` enforces the checksum; a user recovering from a
    damaged backup must still be able to try the words they have, so seed
    derivation never refuses input.
    """
    seed = bip39.mnemonic_to_seed("abandon abandon abandon", "")
    assert len(seed) == 64
    assert seed == bip39.mnemonic_to_seed("abandon abandon abandon", "")
    assert seed != bip39.mnemonic_to_seed(bip39_vectors["vectors"][0]["mnemonic"], "")


def test_normalisation_rules():
    # mnemonics: case and layout are normalised ...
    assert bip39.normalize_mnemonic("  Abandon\tABANDON\nabandon ") == "abandon abandon abandon"
    # ... passphrases are not: only NFKD applies, case is significant
    assert bip39.normalize("Ab\u0063") == "Abc"
    assert bip39.normalize("\u00e9") == "e\u0301"     # NFKD decomposes
    good = "abandon " * 11 + "about"
    assert bip39.mnemonic_to_seed(good, "PaSs") != bip39.mnemonic_to_seed(good, "pass")


def test_electrum_seed_prefix_detection():
    # "standard" Electrum seeds start with a word whose index makes the version
    # bytes 0100, so any valid Electrum mnemonic must be classified, not rejected
    assert bip39.electrum_seed_type("abandon " * 11 + "about") in (None, "standard")


# ----------------------------------------------------------------------- minikey
def test_minikey_official_sample(minikey_vectors):
    entry = minikey_vectors["vectors"][0]
    text = entry["minikey"]
    assert minikey.is_minikey(text)
    assert minikey.is_valid_minikey(text)
    privkey = minikey.privkey_from_minikey(text)
    assert privkey.hex() == entry["privkey_hex"].lower()
    assert encode_wif(privkey, False) == entry["wif_uncompressed"]
    assert p2pkh(_pub(privkey, False)) == entry["address_uncompressed"]


def _pub(privkey: bytes, compressed: bool) -> bytes:
    from keyrescue.crypto.secp256k1 import pubkey_from_privkey

    return pubkey_from_privkey(int.from_bytes(privkey, "big"), compressed)


def test_minikey_marker_and_rejection():
    good = "S6c56bnXQiBjk9mqSYE7ykVQ7NzrRy"
    assert minikey.is_valid_minikey(good)
    # changing one character breaks the typo check (and usually the marker byte)
    broken = good[:-1] + ("a" if good[-1] != "a" else "b")
    assert minikey.is_minikey(broken)
    assert not minikey.is_valid_minikey(broken)
    for not_a_minikey in ("", "6c56bnXQiBjk9mqSYE7ykVQ7NzrRy", "S6c56bnXQiBjk9mqSYE7ykVQ7NzrR"):
        assert not minikey.is_minikey(not_a_minikey)


def test_minikey_info_for_info_command():
    info = minikey.minikey_info("S6c56bnXQiBjk9mqSYE7ykVQ7NzrRy")
    assert info["length"] == 30
    assert info["valid_marker"] is True
    assert info["privkey_wif_uncompressed"] == "5JPy8Zg7z4P7RSLsiqcqyeAF1935zjNUdMxcDeVrtU1oarrgnB7"
    with pytest.raises(InvalidInput):
        minikey.minikey_info("not-a-minikey")


# --------------------------------------------------------------------- secp256k1
@pytest.mark.parametrize("key", [1, 2, 3, 0xFFFFFFFF - 1, N - 1])
def test_every_valid_scalar_yields_a_point(key):
    assert is_valid_privkey(key)
    point = _pubkey(key)
    assert len(point) == 33 and point[0] in (0x02, 0x03)


def test_invalid_privkeys_rejected():
    for bad in (0, N, N + 1, -1):
        assert not is_valid_privkey(bad)
        with pytest.raises(InvalidInput):
            _pubkey(bad)


def _pubkey(key: int) -> bytes:
    from keyrescue.crypto.secp256k1 import pubkey_from_privkey

    return pubkey_from_privkey(key, True)


def test_point_arithmetic_is_consistent():
    """2G computed by doubling must equal G+G and the scalar multiplication."""
    from keyrescue.crypto.secp256k1 import G, point_add, point_mul, pubkey_from_privkey

    assert point_mul(2, G) == point_add(G, G)
    assert pubkey_from_privkey(2, True).hex() == (
        "02c6047f9441ed7d6d3045406e95c07cd85c778e4b8cef3ca7abac09b95c709ee5"
    )


# ------------------------------------------------- pure Python curve fallback
# Every value here was produced by libsecp256k1 (coincurve) and is the standard
# against which the stdlib-only fallback is checked.  These matter because
# `pip install keyrescue` without extras uses the pure Python path for *every*
# mode, so a wrong multiplication means wrong addresses for paying customers.
CURVE_VECTORS = [
    (1, "0279be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798"),
    (2, "02c6047f9441ed7d6d3045406e95c07cd85c778e4b8cef3ca7abac09b95c709ee5"),
    (3, "02f9308a019258c31049344f85f89d5229b531c845836f99b08601f113bce036f9"),
    (7, "025cbdf0646e5db4eaa398f365f2ea7a0e3d419b7e0330e39ce92bddedcac4f9bc"),
    (0xFFFFFFFF, "02ba7e7b78e1ff713857bcc6432dcee5f7c6ca7fc8f84af479811bcabec921305e"),
    (int("0c28fca386c7a227600b2fe50b7cae11ec86d3bf1fbe471be89827e19d72aa1d", 16),
     "02d0de0aaeaefad02b8bdc8a01a1b8b11c696bd3d66a2c5f10780d95b7df42645c"),
]


@pytest.mark.parametrize("scalar,expected", CURVE_VECTORS)
def test_generator_multiplication_known_points(scalar, expected):
    """The published small-scalar points, from the fallback implementation itself."""
    from keyrescue.crypto import secp256k1

    assert secp256k1._serialize(secp256k1._mul_g_py(scalar), True).hex() == expected


def test_fallback_matches_the_accelerated_backend():
    """Cross-check both code paths over small, power-of-two and random scalars."""
    coincurve = pytest.importorskip("coincurve")
    from keyrescue.crypto import secp256k1
    from keyrescue.crypto.secp256k1 import N

    scalars = [1, 2, 15, 16, 17, 255, 256, 0xFFFFFFFF, 2 ** 128 + 7, N - 1,
               int("0c28fca386c7a227600b2fe50b7cae11ec86d3bf1fbe471be89827e19d72aa1d", 16)]
    import random

    rng = random.Random(20261007)
    scalars += [rng.randrange(1, N) for _ in range(20)]
    for scalar in scalars:
        for compressed in (True, False):
            mine = secp256k1._serialize(secp256k1._mul_g_py(scalar), compressed)
            theirs = coincurve.PrivateKey.from_int(scalar).public_key.format(compressed)
            assert mine == theirs, f"pure Python disagrees for {scalar:x} (compressed={compressed})"


def test_fallback_is_internally_consistent():
    """k*G must equal (k-1)*G + G and 2*(k/2)*G, without any backend."""
    from keyrescue.crypto.secp256k1 import G, _mul_g_py, _serialize, point_add

    for k in (17, 255, 4096, 0xDEADBEEF):
        assert _serialize(_mul_g_py(k), True) == _serialize(point_add(_mul_g_py(k - 1), G), True)
        if k % 2 == 0:
            assert _serialize(_mul_g_py(k), True) == _serialize(point_add(_mul_g_py(k // 2),
                                                                           _mul_g_py(k // 2)), True)
