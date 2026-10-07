"""BIP-38 passphrase-protected private keys.

Every official test vector of the BIP is decrypted and compared with the WIF
that the BIP publishes.  That single comparison pins the scrypt parameters, the
AES-256-ECB blockwise xor, the flag byte, the lot/sequence branch and the NFC
normalisation of the passphrase all at once.
"""

from __future__ import annotations

import json
from pathlib import Path

import pytest

from keyrescue.crypto.addresses import p2pkh
from keyrescue.crypto.bip38 import (
    SCRYPT_PARAMS_HARD,
    SCRYPT_PARAMS_SOFT,
    decrypt_bip38,
    is_bip38,
    parse_bip38,
)
from keyrescue.crypto.secp256k1 import pubkey_from_privkey
from keyrescue.crypto.wif import decode_wif, encode_wif
from keyrescue.errors import InvalidEncoding, InvalidInput

pytest.importorskip("Crypto", reason="BIP-38 needs AES -- pip install keyrescue[crypto]")

_DATA = json.loads((Path(__file__).parent / "vectors" / "bip38.json").read_text(encoding="utf-8"))
VECTORS = _DATA["vectors"]
IDS = [f"{i + 1}:{v['group'].split(',')[0]}" for i, v in enumerate(VECTORS)]


def test_scrypt_parameters_are_the_ones_the_bip_fixes():
    assert SCRYPT_PARAMS_HARD == (16384, 8, 8)
    assert SCRYPT_PARAMS_SOFT == (1024, 1, 1)


@pytest.mark.parametrize("entry", VECTORS, ids=IDS)
def test_parse_structure(entry):
    record = parse_bip38(entry["encrypted"])
    assert record.ec_multiplied is entry["ec_multiplied"]
    assert record.compressed is entry["compressed"]
    assert record.has_lot_sequence is (entry["lot"] is not None)
    if entry["ec_multiplied"]:
        assert len(record.owner_entropy) == 8
    else:
        assert record.owner_entropy == b""


@pytest.mark.parametrize("entry", VECTORS, ids=IDS)
def test_decrypt_matches_the_published_key(entry):
    out = decrypt_bip38(entry["encrypted"], entry["passphrase"])
    assert out is not None, "the correct passphrase must decrypt"
    privkey, compressed = out
    assert compressed is entry["compressed"]
    assert encode_wif(privkey, compressed) == entry["wif"]
    if entry["privkey_hex"]:
        assert privkey.hex() == entry["privkey_hex"].lower()
    if entry["address"]:
        assert p2pkh(pubkey_from_privkey(int.from_bytes(privkey, "big"), compressed)) == entry["address"]


@pytest.mark.parametrize("entry", VECTORS, ids=IDS)
def test_wrong_passphrase_is_refused(entry):
    assert decrypt_bip38(entry["encrypted"], entry["passphrase"] + "x") is None


@pytest.mark.parametrize("entry", VECTORS, ids=IDS)
def test_is_bip38_detects_the_format(entry):
    assert is_bip38(entry["encrypted"])


def test_nfc_normalisation_is_required_for_vector_three():
    """The BIP notes that this passphrase normalises to a specific byte string."""
    import unicodedata

    entry = VECTORS[2]
    assert unicodedata.normalize("NFC", entry["passphrase"]).encode("utf-8").hex() == (
        "cf9300f0909080f09f92a9"
    )
    assert decrypt_bip38(entry["encrypted"], entry["passphrase"]) is not None


def test_wif_and_bip38_agree_on_the_underlying_key():
    """Decoding the published WIF must give the same key the record decrypts to."""
    entry = VECTORS[0]
    info = decode_wif(entry["wif"])
    out = decrypt_bip38(entry["encrypted"], entry["passphrase"])
    assert out[0] == info.privkey


@pytest.mark.parametrize(
    "junk",
    [
        "6PRVWUbkzzsbcVac2qwfssoUJAN1Xhrg6bNk8J7Nzm5H7kxEbn2Nh2ZoGh",  # bad checksum
        "5HueCGU8rMjxEXxiPuD5BDku4MkFqeZyd4dZ1jvhTVqvbTLvyTJ",           # WIF, not BIP-38
        "6Prvwubkzzsbcvac2qwfssouljan1xhr",                              # wrong length
        "",
    ],
)
def test_non_bip38_strings_rejected(junk):
    assert not is_bip38(junk)
    with pytest.raises((InvalidEncoding, InvalidInput)):
        parse_bip38(junk)


def test_reserved_flag_bits_are_rejected():
    """BIP-38: the top two flag bits are 11 for non-EC keys and 00 for EC keys."""
    from keyrescue.crypto import base58

    record = parse_bip38(VECTORS[0]["encrypted"])
    payload = base58.b58check_decode(VECTORS[0]["encrypted"])

    for bad_flag in (0x00, 0x40, 0x80, 0xF0):  # non-EC needs 0xC0 set
        corrupted = bytearray(payload)
        corrupted[2] = bad_flag
        text = base58.b58check_encode(bytes(corrupted))
        with pytest.raises((InvalidInput, InvalidEncoding)):
            parse_bip38(text)

    # a lot/sequence flag on a non-EC key is illegal, 0x04 is EC-only
    corrupted = bytearray(payload)
    corrupted[2] = 0xC4
    with pytest.raises(InvalidInput):
        parse_bip38(base58.b58check_encode(bytes(corrupted)))
    assert record.flagbyte == 0xC0
