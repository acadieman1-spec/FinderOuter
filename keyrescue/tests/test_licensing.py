"""Offline licensing: the Ed25519 primitive and the KR1 key format.

Ed25519 is checked against the RFC 8032 test vector, and -- when PyNaCl is
installed -- against NaCl itself in both directions, so the signature scheme
used to authorise every paid feature is verified rather than trusted.
"""

from __future__ import annotations

import base64
import os
from datetime import date, datetime, timedelta, timezone

import pytest

from keyrescue.errors import LicenseError
from keyrescue.licensing import ed25519, keys as keyring
from keyrescue.licensing.license import (
    LicenseClaims,
    LicenseStore,
    decode_license,
    default_license_path,
    encode_license,
    free_license,
    verify_license,
)

# RFC 8032 section 7.1, test 1 (empty message).
RFC_SEED = bytes.fromhex("9d61b19deffd5a60ba844af492ec2cc44449c5697b326919703bac031cae7f60")
RFC_PUBLIC = "d75a980182b10ab7d54bfed3c964073a0ee172f3daa62325af021a68f707511a"
RFC_SIGNATURE = (
    "e5564300c360ac729086e2cc806e828a84877f1eb8e5d974d873e06522490155"
    "5fb8821590a33bacc61e39701cf9b46bd25bf5f0595bbe24655141438e7a100b"
)


@pytest.fixture
def vendor(monkeypatch):
    """A throwaway vendor key pair installed for the duration of a test."""
    seed, public = ed25519.create_keypair()
    monkeypatch.setattr(keyring, "VENDOR_PUBLIC_KEYS", (public.hex(),))
    monkeypatch.delenv("KEYRESCUE_ALLOW_DEV_KEYS", raising=False)
    return seed, public


# ------------------------------------------------------------------- ed25519
def test_publickey_matches_rfc8032():
    assert ed25519.publickey(RFC_SEED).hex() == RFC_PUBLIC


def test_signature_matches_rfc8032():
    assert ed25519.sign(b"", RFC_SEED).hex() == RFC_SIGNATURE


def test_verify_accepts_the_rfc_vector():
    assert ed25519.verify(bytes.fromhex(RFC_SIGNATURE), b"", bytes.fromhex(RFC_PUBLIC))


@pytest.mark.parametrize("length", [0, 1, 32, 100, 1000])
def test_sign_verify_round_trip(length):
    seed, public = ed25519.create_keypair()
    message = os.urandom(length)
    signature = ed25519.sign(message, seed)
    assert len(signature) == 64
    assert ed25519.verify(signature, message, public)


def test_signatures_are_deterministic():
    seed, _ = ed25519.create_keypair()
    assert ed25519.sign(b"same", seed) == ed25519.sign(b"same", seed)
    assert ed25519.sign(b"same", seed) != ed25519.sign(b"other", seed)


@pytest.mark.parametrize(
    "mutate",
    [
        lambda msg, sig, pub: (msg + b"!", sig, pub),
        lambda msg, sig, pub: (msg, bytes([sig[0] ^ 0x01]) + sig[1:], pub),
        lambda msg, sig, pub: (msg, sig[:-1] + bytes([(sig[-1] + 1) % 256]), pub),
    ],
)
def test_verify_rejects_tampering(mutate):
    seed, public = ed25519.create_keypair()
    message, signature = b"license payload", ed25519.sign(b"license payload", seed)
    msg, sig, pub = mutate(message, signature, public)
    assert ed25519.verify(sig, msg, pub) is False


def test_verify_rejects_other_keys_and_shapes():
    seed, public = ed25519.create_keypair()
    other_seed, other_public = ed25519.create_keypair()
    signature = ed25519.sign(b"data", seed)
    assert ed25519.verify(signature, b"data", other_public) is False
    assert ed25519.verify(signature[:32], b"data", public) is False
    assert ed25519.verify(b"", b"data", public) is False
    assert ed25519.verify(signature, b"data", b"\x00" * 31) is False


def test_keypair_helpers():
    seed = bytes(32)
    made_seed, public = ed25519.create_keypair(seed)
    assert made_seed == seed and public == ed25519.publickey(seed)
    random_seed, _ = ed25519.create_keypair()
    assert len(random_seed) == ed25519.SEED_SIZE == 32
    with pytest.raises(ValueError):
        ed25519.create_keypair(b"too short")


def test_matches_pynacl_both_directions():
    """Cross-check the implementation against NaCl, when available."""
    nacl_signing = pytest.importorskip("nacl.signing")
    for i in range(8):
        seed = bytes([i]) * 32
        message = os.urandom(i * 11 + 1)
        public = ed25519.publickey(seed)
        assert public == bytes(nacl_signing.SigningKey(seed).verify_key)
        # NaCl must accept what we produce ...
        nacl_signing.VerifyKey(public).verify(message, ed25519.sign(message, seed))
        # ... and we must accept what NaCl produces
        assert ed25519.verify(nacl_signing.SigningKey(seed).sign(message).signature, message, public)
        # flip a bit inside R (the top byte of S is always zero, so mutating it
        # there would leave the signature unchanged)
        broken = bytearray(ed25519.sign(message, seed))
        broken[9] ^= 0x01
        with pytest.raises(Exception):
            nacl_signing.VerifyKey(public).verify(message, bytes(broken))
        assert ed25519.verify(bytes(broken), message, public) is False


# ------------------------------------------------------------------ key format
def test_key_is_base32_and_carries_the_prefix(vendor):
    seed, _ = vendor
    text = encode_license(seed, {"id": "k1", "tier": "pro"})
    assert text.startswith("KR1-")
    payload, signature = decode_license(text)
    assert b'"tier":"pro"' in payload
    assert len(signature) == 64
    payload_part, signature_part = text.split("-")[1:3]
    assert not payload_part.endswith("=") and not signature_part.endswith("=")   # unpadded
    assert set(payload_part) <= set("ABCDEFGHIJKLMNOPQRSTUVWXYZ234567")
    assert base64.b32decode(payload_part + "=" * (-len(payload_part) % 8)) == payload
    assert base64.b32decode(signature_part + "=" * (-len(signature_part) % 8)) == signature


def test_decode_tolerates_paste_artifacts(vendor):
    seed, _ = vendor
    text = encode_license(seed, {"id": "k2", "tier": "pro", "name": "A Buyer"})
    messed = "  " + text.lower().replace("-", " - ") + "\n"
    assert decode_license(messed) == decode_license(text)
    assert verify_license(messed).claims.id == "k2"


@pytest.mark.parametrize(
    "junk",
    ["", "   ", "KR1-onlyonepart", "XXXX-abc-def", "KR1-!!!-!!!", "KR1-AB==-CD"],
)
def test_malformed_keys_are_refused(junk):
    with pytest.raises(LicenseError):
        decode_license(junk)


# -------------------------------------------------------------------- verify
def test_round_trip_grants_the_tier(vendor):
    seed, _ = vendor
    license_obj = verify_license(encode_license(seed, {"id": "c", "tier": "pro", "name": "Buyer"}))
    assert license_obj.tier.name == "pro" and license_obj.is_pro
    assert license_obj.name == "Buyer" and not license_obj.expired
    assert license_obj.claims.id == "c"
    assert "Pro" in license_obj.describe() and "never (perpetual)" in license_obj.describe()


def test_tier_names_are_normalised(vendor):
    seed, _ = vendor
    assert verify_license(encode_license(seed, {"id": "c", "tier": "TEAM"})).tier.name == "team"


def test_unknown_tier_is_rejected(vendor):
    seed, _ = vendor
    with pytest.raises(LicenseError, match="unknown license tier"):
        verify_license(encode_license(seed, {"id": "c", "tier": "platinum"}))


def test_missing_required_claims_are_refused(vendor):
    seed, _ = vendor
    with pytest.raises(LicenseError, match="missing 'id'"):
        verify_license(encode_license(seed, {"tier": "pro"}))
    with pytest.raises(LicenseError, match="missing 'tier'"):
        verify_license(encode_license(seed, {"id": "c"}))


def test_tampered_claims_are_rejected(vendor):
    seed, _ = vendor
    text = encode_license(seed, {"id": "c", "tier": "trial"})
    payload, signature = decode_license(text)
    forged = payload.replace(b"trial", b"pro")
    tampered = "KR1-" + base64.b32encode(forged).decode().rstrip("=") + "-" + \
               base64.b32encode(signature).decode().rstrip("=")
    with pytest.raises(LicenseError, match="does not verify"):
        verify_license(tampered)


def test_foreign_key_is_rejected(vendor):
    _, our_public = vendor
    stranger, _ = ed25519.create_keypair()
    assert stranger != our_public
    with pytest.raises(LicenseError, match="does not verify"):
        verify_license(encode_license(stranger, {"id": "x", "tier": "pro"}))


def test_build_without_a_vendor_key_says_so(monkeypatch):
    monkeypatch.setattr(keyring, "VENDOR_PUBLIC_KEYS", ())
    monkeypatch.delenv("KEYRESCUE_ALLOW_DEV_KEYS", raising=False)
    seed, _ = ed25519.create_keypair()
    with pytest.raises(LicenseError, match="no vendor public key"):
        verify_license(encode_license(seed, {"id": "c", "tier": "pro"}))


def test_dev_key_only_with_opt_in(monkeypatch):
    """A key signed with the development seed is inert unless explicitly allowed."""
    dev_seed, dev_public = ed25519.create_keypair()
    monkeypatch.setattr(keyring, "VENDOR_PUBLIC_KEYS", ())
    monkeypatch.setattr(keyring, "DEV_PUBLIC_KEY", dev_public.hex())
    text = encode_license(dev_seed, {"id": "dev", "tier": "pro"})

    monkeypatch.delenv("KEYRESCUE_ALLOW_DEV_KEYS", raising=False)
    assert keyring.ALLOW_DEV_KEYS() is False
    with pytest.raises(LicenseError, match="no vendor public key"):
        verify_license(text)

    for value in ("1", "true", "YES", "on"):
        monkeypatch.setenv("KEYRESCUE_ALLOW_DEV_KEYS", value)
        assert keyring.ALLOW_DEV_KEYS() is True
        assert verify_license(text).tier.name == "pro"

    monkeypatch.setenv("KEYRESCUE_ALLOW_DEV_KEYS", "0")
    assert keyring.ALLOW_DEV_KEYS() is False


def test_expiry_downgrades_to_free(vendor):
    seed, _ = vendor
    yesterday = (date.today() - timedelta(days=1)).isoformat()
    license_obj = verify_license(encode_license(seed, {"id": "c", "tier": "pro", "exp": yesterday}))
    assert license_obj.expired is True
    assert license_obj.tier.name == "free"
    assert not license_obj.is_pro
    assert "expired" in license_obj.warning and "EXPIRED" in license_obj.describe()


def test_expiring_soon_warns_but_keeps_the_tier(vendor):
    seed, _ = vendor
    soon = (date.today() + timedelta(days=10)).isoformat()
    license_obj = verify_license(encode_license(seed, {"id": "c", "tier": "pro", "exp": soon}))
    assert license_obj.expired is False and license_obj.tier.name == "pro"
    assert "expires soon" in license_obj.warning


def test_expiry_boundary_is_the_whole_day(vendor):
    seed, _ = vendor
    today = date.today().isoformat()
    assert verify_license(encode_license(seed, {"id": "c", "tier": "pro", "exp": today})).expired is False
    assert verify_license(
        encode_license(seed, {"id": "c", "tier": "pro", "exp": today}),
        now=datetime(2999, 1, 1, tzinfo=timezone.utc),
    ).expired is True


def test_bad_expiry_date_is_reported(vendor):
    seed, _ = vendor
    with pytest.raises(LicenseError, match="invalid expiry date"):
        verify_license(encode_license(seed, {"id": "c", "tier": "pro", "exp": "not-a-date"}))


# ---------------------------------------------------------------------- tiers
def test_tier_matrix():
    free, trial, pro, team = (keyring.get_tier(name) for name in ("free", "trial", "pro", "team"))
    assert free.max_candidates == 1_000_000 and free.max_threads == 1
    assert free.permits_candidates(1_000_000) and not free.permits_candidates(1_000_001)
    assert free.permits_threads(1) and not free.permits_threads(2)
    assert not free.allow_sessions
    for tier in (trial, pro, team):
        assert tier.max_candidates is None and tier.max_threads is None
        assert tier.allow_sessions and tier.permits_candidates(2**200)
    assert set(keyring.TIERS) == {"free", "trial", "pro", "team"}


def test_get_tier_falls_back_to_free():
    assert keyring.get_tier("nope").name == "free"


def test_free_license_is_inert():
    license_obj = free_license()
    assert license_obj.tier.name == "free" and not license_obj.is_pro
    assert license_obj.claims.id == "free"


def test_claims_round_trip_and_omission_of_defaults():
    claims = LicenseClaims(id="c", tier="pro", name="N", exp="2027-01-01", seats=3, issued="2026-10-07")
    data = claims.to_dict()
    assert data == {"id": "c", "tier": "pro", "name": "N", "exp": "2027-01-01", "seats": 3,
                   "issued": "2026-10-07"}
    assert LicenseClaims.from_dict(data) == claims
    minimal = LicenseClaims(id="c", tier="free")
    assert minimal.to_dict() == {"id": "c", "tier": "free"}
    assert minimal.expiry_date is None


@pytest.mark.parametrize("bad", [{"tier": "pro"}, {"id": "x"}, {}, {"id": "", "tier": "pro"}])
def test_claims_require_id_and_tier(bad):
    with pytest.raises(LicenseError):
        LicenseClaims.from_dict(bad)


# --------------------------------------------------------------------- store
def test_store_uses_the_env_override(vendor, tmp_path, monkeypatch):
    seed, _ = vendor
    monkeypatch.setenv("KEYRESCUE_LICENSE_PATH", str(tmp_path / "conf" / "license.key"))
    assert default_license_path() == tmp_path / "conf" / "license.key"
    store = LicenseStore()
    assert store.current().tier.name == "free"
    path = store.save(encode_license(seed, {"id": "c", "tier": "pro"}))
    assert path.exists()
    assert store.current().tier.name == "pro"
    assert store.remove() is True and store.remove() is False


def test_store_respects_xdg_config_home(vendor, tmp_path, monkeypatch):
    monkeypatch.delenv("KEYRESCUE_LICENSE_PATH", raising=False)
    monkeypatch.setenv("XDG_CONFIG_HOME", str(tmp_path))
    assert default_license_path() == tmp_path / "keyrescue" / "license.key"


def test_environment_license_wins_over_the_file(vendor, tmp_path, monkeypatch):
    seed, _ = vendor
    monkeypatch.setenv("KEYRESCUE_LICENSE_PATH", str(tmp_path / "license.key"))
    (tmp_path / "license.key").write_text(encode_license(seed, {"id": "file", "tier": "trial"}), encoding="utf-8")
    store = LicenseStore()
    assert store.current().claims.id == "file"
    monkeypatch.setenv("KEYRESCUE_LICENSE", encode_license(seed, {"id": "env", "tier": "team"}))
    assert store.current().claims.id == "env"


def test_store_reports_an_unreadable_file(tmp_path, monkeypatch):
    path = tmp_path / "license.key"
    path.write_bytes(b"\xff\xfe\x00binary")
    monkeypatch.setenv("KEYRESCUE_LICENSE_PATH", str(path))
    monkeypatch.delenv("KEYRESCUE_LICENSE", raising=False)
    with pytest.raises(LicenseError, match="could not be read"):
        LicenseStore().current()


def test_store_rejects_a_license_from_another_vendor(vendor, tmp_path, monkeypatch):
    stranger, _ = ed25519.create_keypair()
    monkeypatch.setenv("KEYRESCUE_LICENSE_PATH", str(tmp_path / "license.key"))
    (tmp_path / "license.key").write_text(encode_license(stranger, {"id": "c", "tier": "pro"}), encoding="utf-8")
    monkeypatch.delenv("KEYRESCUE_LICENSE", raising=False)
    with pytest.raises(LicenseError, match="does not verify"):
        LicenseStore().current()


def test_saved_file_is_private(vendor, tmp_path, monkeypatch):
    seed, _ = vendor
    monkeypatch.setenv("KEYRESCUE_LICENSE_PATH", str(tmp_path / "license.key"))
    path = LicenseStore().save(encode_license(seed, {"id": "c", "tier": "pro"}))
    if os.name != "nt":
        assert oct(path.stat().st_mode & 0o777) == "0o600"


def test_current_records_where_the_license_came_from(vendor, tmp_path, monkeypatch):
    seed, _ = vendor
    monkeypatch.setenv("KEYRESCUE_LICENSE_PATH", str(tmp_path / "license.key"))
    monkeypatch.delenv("KEYRESCUE_LICENSE", raising=False)
    LicenseStore().save(encode_license(seed, {"id": "c", "tier": "pro"}))
    license_obj = LicenseStore().current()
    assert str(tmp_path / "license.key") in license_obj.source
    assert license_obj.warning == ""          # nothing to warn about
    monkeypatch.setenv("KEYRESCUE_LICENSE", encode_license(seed, {"id": "c", "tier": "team"}))
    assert "KEYRESCUE_LICENSE" in LicenseStore().current().source
