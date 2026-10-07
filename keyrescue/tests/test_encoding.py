"""Encodings: Base58Check, Bech32/Bech32m, WIF and address -> scriptPubKey.

The Bech32 vectors come from BIP-173 and BIP-350 (see
``tools/fetch_spec_vectors.py``); the WIF and address values are the ones those
BIPs and the Bitcoin Wiki publish for the private key ``1`` and for the
well-known minikey sample.
"""

from __future__ import annotations

import pytest

from keyrescue.crypto import base58, bech32
from keyrescue.crypto.addresses import (
    NETWORKS,
    decode_address,
    p2pkh,
    p2sh,
    p2tr,
    p2wpkh,
    script_pubkey_for_address,
    segwit_script_pubkey,
)
from keyrescue.crypto.hashes import hash160
from keyrescue.crypto.secp256k1 import G, pubkey_from_privkey
from keyrescue.crypto.wif import decode_wif, encode_wif, is_wif
from keyrescue.errors import InvalidEncoding, InvalidInput

KEY_ONE = 1
PUB_ONE = "0279be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798"
# uncompressed form of the same point: 04 || x || y, with (x, y) = G
PUB_ONE_UNCOMPRESSED = "04" + PUB_ONE[2:] + "%064x" % G[1]
HASH160_ONE = "751e76e8199196d454941c45d1b3a323f1433bd6"


# ------------------------------------------------------------------ base58check
def test_base58check_round_trip():
    payload = b"\x00" + bytes.fromhex(HASH160_ONE)
    text = base58.b58check_encode(payload)
    assert text == "1BgGZ9tcN4rm9KBzDn7KprQz87SZ26SAMH"
    assert base58.b58check_decode(text) == payload


@pytest.mark.parametrize(
    "text",
    [
        "1BgGZ9tcN4rm9KBzDn7KprQz87SZ26SAMH0",  # wrong checksum
        "1BgGZ9tcN4rm9KBzDn7KprQz87SZ26SAM0",
        "0OIl",  # characters excluded from the alphabet
        "",
    ],
)
def test_base58check_rejects_bad_input(text):
    with pytest.raises((InvalidEncoding, InvalidInput)):
        base58.b58check_decode(text)


def test_base58_leading_zero_bytes_are_preserved():
    payload = b"\x00\x00\x00" + b"\x11" * 20
    assert base58.b58check_decode(base58.b58check_encode(payload)) == payload


def test_has_invalid_chars():
    assert base58.has_invalid_chars("abcXYZ123") is None
    assert base58.has_invalid_chars("abc0") == "0"


# ------------------------------------------------------------------------ bech32
def test_bech32_valid_vectors(bech32_vectors):
    for entry in bech32_vectors["valid"]:
        hrp, witver, program = bech32.decode_segwit_address(entry["address"])
        assert segwit_script_pubkey(witver, program).hex() == entry["script"], entry["address"]


def test_bech32_rejects_superseded_vectors(bech32_vectors):
    """BIP-350 requires Bech32m for witness version 1 and above."""
    for entry in bech32_vectors["superseded_by_bip350"]:
        with pytest.raises(InvalidEncoding):
            bech32.decode_segwit_address(entry["address"])


def test_bech32_rejects_invalid_vectors(bech32_vectors):
    checked = 0
    for entry in bech32_vectors["invalid"]:
        address = entry["address"]
        # the spec prose also lists placeholder rows that are not addresses
        if " " in address or len(address) < 25 or not any(c.isdigit() for c in address):
            continue
        checked += 1
        with pytest.raises((InvalidEncoding, InvalidInput)):
            decode_address(address)
    assert checked > 15, "vector file looks truncated"


def test_bech32_encode_decode_round_trip():
    program = bytes.fromhex(HASH160_ONE)
    address = bech32.encode_segwit_address("bc", 0, program)
    assert address == "bc1qw508d6qejxtdg4y5r3zarvary0c5xw7kv8f3t4"
    assert bech32.decode_segwit_address(address) == ("bc", 0, program)
    # encoding is lowercase, decoding is case insensitive (except mixed case)
    assert bech32.decode_segwit_address(address.upper()) == ("bc", 0, program)


def test_bech32_mixed_case_rejected():
    with pytest.raises(InvalidEncoding):
        bech32.decode_segwit_address("BC1qw508d6qejxtdg4y5r3zarvary0c5xw7kv8f3t4")


def test_convertbits_round_trip():
    data = bytes(range(32))
    five = bech32.convertbits(data, 8, 5)
    assert bech32.convertbits(five, 5, 8, pad=False) == list(data)


# --------------------------------------------------------------------- addresses
G_POINT_UNCOMPRESSED = (
    # SEC 2, section 2.3.4: the generator point of secp256k1
    "0479be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798"
    "483ada7726a3c4655da4fbfc0e1108a8fd17b448a68554199c47d08ffb10d4b8"
)


def test_generator_point_is_the_published_one():
    assert "04" + "%064x" % G[0] + "%064x" % G[1] == G_POINT_UNCOMPRESSED
    # the private key 1 *is* the generator point
    assert pubkey_from_privkey(1, False).hex() == G_POINT_UNCOMPRESSED
    assert pubkey_from_privkey(1, True).hex() == PUB_ONE


def test_generator_point_matches_libsecp256k1():
    """Independent oracle: libsecp256k1 through coincurve, when installed."""
    coincurve = pytest.importorskip("coincurve")
    for key in (1, 2, 3, 2**128 + 7):
        ours = pubkey_from_privkey(key, True)
        theirs = coincurve.PrivateKey.from_int(key).public_key.format(True)
        assert ours == theirs, f"public key mismatch for {key}"


def test_address_types_for_private_key_one():
    compressed = pubkey_from_privkey(KEY_ONE, True)
    uncompressed = pubkey_from_privkey(KEY_ONE, False)
    assert compressed.hex() == PUB_ONE
    assert uncompressed.hex() == PUB_ONE_UNCOMPRESSED

    # ground truth: hash160 of the compressed key-1 pubkey is the BIP-173 program
    assert p2pkh(compressed) == "1BgGZ9tcN4rm9KBzDn7KprQz87SZ26SAMH"
    assert p2pkh(uncompressed) == base58.b58check_encode(b"\x00" + hash160(uncompressed))
    assert p2pkh(uncompressed) != p2pkh(compressed)
    assert p2wpkh(compressed) == "bc1qw508d6qejxtdg4y5r3zarvary0c5xw7kv8f3t4"
    # nested SegWit (BIP-49): hash160 of 0x0014 || hash160(pubkey), prefixed 0x05
    assert p2sh(compressed) == base58.b58check_encode(
        b"\x05" + hash160(b"\x00\x14" + hash160(compressed))
    )
    assert decode_address(p2sh(compressed)).kind == "p2sh"
    assert decode_address(p2tr(compressed)).kind == "p2tr"


def test_testnet_and_regtest_hrp():
    pub = pubkey_from_privkey(KEY_ONE, True)
    assert p2wpkh(pub, "testnet").startswith("tb1q")
    assert p2wpkh(pub, "regtest").startswith("bcrt1q")
    assert decode_address(p2wpkh(pub, "regtest")).network == "regtest"
    assert set(NETWORKS) == {"mainnet", "testnet", "regtest"}


def test_script_pubkey_for_every_kind():
    pub = pubkey_from_privkey(KEY_ONE, True)
    assert script_pubkey_for_address(p2pkh(pub)).hex() == f"76a914{HASH160_ONE}88ac"
    assert script_pubkey_for_address(p2wpkh(pub)).hex() == f"0014{HASH160_ONE}"
    p2sh_p2wpkh = script_pubkey_for_address(p2sh(pub))
    assert p2sh_p2wpkh.hex().startswith("a914") and p2sh_p2wpkh.endswith(b"\x87")
    taproot = script_pubkey_for_address(p2tr(pub))
    assert taproot[0] == 0x51 and taproot[1] == 0x20 and len(taproot) == 34


def test_segwit_script_pubkey_bounds():
    with pytest.raises(InvalidInput):
        segwit_script_pubkey(17, b"\x00" * 32)
    with pytest.raises(InvalidInput):
        segwit_script_pubkey(-1, b"\x00" * 32)


def test_decode_address_rejects_junk():
    for bad in ("", "   ", "not an address", "bc1q", "1BgGZ9tcN4rm9KBzDn7KprQz87SZ26SAM",
                "tc1qw508d6qejxtdg4y5r3zarvary0c5xw7kg3g4ty"):
        with pytest.raises((InvalidEncoding, InvalidInput)):
            decode_address(bad)

    # surrounding whitespace is tolerated
    assert decode_address("  bc1qw508d6qejxtdg4y5r3zarvary0c5xw7kv8f3t4  ").kind == "p2wpkh"


# ---------------------------------------------------------------------------- WIF
def test_wif_vectors():
    privkey = bytes.fromhex("0c28fca386c7a227600b2fe50b7cae11ec86d3bf1fbe471be89827e19d72aa1d")
    assert encode_wif(privkey, False) == "5HueCGU8rMjxEXxiPuD5BDku4MkFqeZyd4dZ1jvhTVqvbTLvyTJ"
    assert encode_wif(privkey, True) == "KwdMAjGmerYanjeui5SHS7JkmpZvVipYvB2LJGU1ZxJwYvP98617"

    info = decode_wif("5HueCGU8rMjxEXxiPuD5BDku4MkFqeZyd4dZ1jvhTVqvbTLvyTJ")
    assert info.privkey == privkey
    assert info.compressed is False
    assert info.privkey_int == int.from_bytes(privkey, "big")


def test_wif_round_trip_accepts_int_or_bytes():
    for key in (1, 2**255 + 17, int("0c28fca386c7a227600b2fe50b7cae11ec86d3bf1fbe471be89827e19d72aa1d", 16)):
        for compressed in (True, False):
            text = encode_wif(key, compressed)
            info = decode_wif(text)
            assert info.compressed is compressed
            assert info.privkey_int == key


def test_is_wif_and_rejects():
    assert is_wif("5HueCGU8rMjxEXxiPuD5BDku4MkFqeZyd4dZ1jvhTVqvbTLvyTJ")
    assert not is_wif("1BgGZ9tcN4rm9KBzDn7KprQz87SZ26SAMH")
    assert not is_wif("5HueCGU8rMjxEXxiPuD5BDku4MkFqeZyd4dZ1jvhTVqvbTLvyT")
    with pytest.raises((InvalidEncoding, InvalidInput)):
        decode_wif("KwdMAjGmerYanjeui5SHS7JkmpZvVipYvB2LJGU1ZxJwYvP98618")
