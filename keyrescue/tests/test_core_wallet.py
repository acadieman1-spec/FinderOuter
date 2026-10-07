"""Bitcoin Core ``wallet.dat`` master key records.

The reference for the key derivation and the padding check is ``crypter.cpp``
(``BytesToKeySHA512AES`` plus ``EncryptSecret``), which is re-implemented here in
the test with the ``cryptography``/pycryptodome primitives so the product code
and the test do not share a code path for the padding logic.
"""

from __future__ import annotations

import pytest

from keyrescue.crypto.core_wallet import (
    DEFAULT_ITERATIONS,
    PADDING_BLOCK,
    MasterKeyRecord,
    check_password,
    decrypt_master_key,
    derive_key_iv,
    find_master_key_records,
    load_record_from_params,
)
from keyrescue.errors import InvalidInput

AES = pytest.importorskip("Crypto.Cipher.AES", reason="needs pycryptodome (pip install keyrescue[crypto])")

PASSPHRASE = b"correct horse battery staple"
SALT = bytes(range(8, 16))


def build_record(passphrase: bytes = PASSPHRASE, salt: bytes = SALT, iterations: int = 25000,
                 master_key: bytes = bytes(range(32))):
    """Encrypt a master key the way Bitcoin Core does."""
    key, iv = derive_key_iv(passphrase, salt, iterations)
    cipher = AES.new(key, AES.MODE_CBC, iv)
    crypted = cipher.encrypt(master_key + PADDING_BLOCK)
    return MasterKeyRecord(crypted, salt, iterations), master_key


def test_bytes_to_key_matches_openssl_derivation_shape():
    """Core: SHA-512(pass||salt), then (iterations-1) further SHA-512 rounds."""
    import hashlib

    key, iv = derive_key_iv(b"hunter2", SALT, 3)
    buf = hashlib.sha512(b"hunter2" + SALT).digest()
    for _ in range(2):
        buf = hashlib.sha512(buf).digest()
    assert key == buf[:32]
    assert iv == buf[32:48]
    assert len(key) == 32 and len(iv) == 16


def test_derivation_rejects_nonsense():
    with pytest.raises(InvalidInput):
        derive_key_iv(b"x", SALT, 1, method=1)
    with pytest.raises(InvalidInput):
        derive_key_iv(b"x", SALT, 0)
    with pytest.raises(InvalidInput):
        derive_key_iv(b"x", SALT, 10_000_001)


def test_record_validation():
    with pytest.raises(InvalidInput):
        MasterKeyRecord(b"\x00" * 47, SALT, 25000)      # crypted key must be 48 bytes
    with pytest.raises(InvalidInput):
        MasterKeyRecord(b"\x00" * 48, b"\x00" * 7, 25000)  # salt must be 8 bytes
    with pytest.raises(InvalidInput):
        MasterKeyRecord(b"\x00" * 48, SALT, 0)


def test_correct_password_passes_fast_check_and_decrypts():
    record, master_key = build_record()
    assert check_password(PASSPHRASE, record) is True
    assert decrypt_master_key(PASSPHRASE, record) == master_key


@pytest.mark.parametrize("wrong", [b"", b"wrong", b"Correct horse battery staple", b"correct horse battery stapl3"])
def test_wrong_password_is_rejected(wrong):
    record, _ = build_record()
    assert check_password(wrong, record) is False
    assert decrypt_master_key(wrong, record) is None


def test_fast_check_agrees_with_the_full_decrypt():
    """The 128 bit padding test must never accept a key the decrypt would reject."""
    record, master = build_record()
    for guess in (PASSPHRASE, b"nope", b"", PASSPHRASE.upper()):
        assert check_password(guess, record) is (decrypt_master_key(guess, record) == master)


def test_iterations_are_honoured():
    for iterations in (1, 100, DEFAULT_ITERATIONS, 60000):
        record, master = build_record(iterations=iterations)
        assert decrypt_master_key(PASSPHRASE, record) == master

    # a record that stores the wrong count cannot be decrypted: the count is part
    # of the key derivation, not just metadata
    record, master = build_record(iterations=25000)
    tampered = MasterKeyRecord(record.crypted_key, record.salt, 24999)
    assert decrypt_master_key(PASSPHRASE, tampered) is None
    assert check_password(PASSPHRASE, tampered) is False


def test_find_records_in_a_wallet_blob():
    record, master = build_record()
    serialised = (
        bytes([48]) + record.crypted_key + bytes([8]) + record.salt
        + (0).to_bytes(4, "little") + record.iterations.to_bytes(4, "little") + b"\x00"
    )
    blob = bytes.fromhex("00112233") + b"mkey" + b"\x00" * 12 + serialised + b"trailing"
    found = find_master_key_records(blob)
    assert len(found) == 1
    assert decrypt_master_key(PASSPHRASE, found[0]) == master
    assert found[0].source == "wallet.dat"
    assert found[0].offset == blob.find(b"mkey") + 4 + 12


def test_find_records_ignores_unrelated_files():
    assert find_master_key_records(b"mkey" + b"\x00" * 200) == []
    assert find_master_key_records(b"\x00" * 4096) == []
    assert find_master_key_records(b"") == []


def test_load_from_params_dict_and_json():
    record, master = build_record()
    params = {
        "crypted_key": record.crypted_key.hex(),
        "salt": record.salt.hex(),
        "iterations": record.iterations,
    }
    assert decrypt_master_key(PASSPHRASE, load_record_from_params(params)[0]) == master
    import json

    loaded = load_record_from_params(json.dumps({"mkey": [params]}))
    assert len(loaded) == 1 and decrypt_master_key(PASSPHRASE, loaded[0]) == master


def test_load_from_params_accepts_alternative_key_names():
    record, master = build_record()
    params = {"ekey": record.crypted_key.hex(), "salt": record.salt.hex(),
              "n_derive_iterations": record.iterations}
    assert decrypt_master_key(PASSPHRASE, load_record_from_params(params)[0]) == master


@pytest.mark.parametrize("bad", [
    "{}",
    '{"salt": "00"}',
    '{"crypted_key": "00", "salt": "00", "iterations": 0}',
    'not json',
])
def test_load_from_params_reports_usage_errors(bad):
    with pytest.raises(InvalidInput):
        load_record_from_params(bad)


def test_to_dict_is_json_friendly():
    import json

    record, _ = build_record()
    payload = json.loads(json.dumps(record.to_dict()))
    assert payload["iterations"] == 25000
    assert bytes.fromhex(payload["crypted_key"]) == record.crypted_key
