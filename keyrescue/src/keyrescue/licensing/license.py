"""Offline license keys.

A license key is a self contained, signed string::

    KR1-<base32 payload>-<base32 signature>

* payload  -- compact JSON: ``{"id":..,"name":..,"tier":..,"exp":..,"seats":..}``
* signature-- Ed25519 signature over the exact payload bytes (64 bytes)

Because the payload is signed and the public key is baked into this build,
activation works with no network access at all -- which matters for a tool that
is meant to run on an air-gapped recovery machine.  Verification also happens
on every run, so a licence cannot be transferred by copying a config file to a
machine running a different build (the vendor key differs).
"""

from __future__ import annotations

import base64
import json
import os
import time
from dataclasses import dataclass
from datetime import date, datetime, timedelta, timezone
from pathlib import Path

from ..errors import LicenseError
from . import ed25519
from . import keys as keyring
from .keys import Tier, get_tier

__all__ = [
    "License",
    "encode_license",
    "decode_license",
    "verify_license",
    "LicenseStore",
    "LicenseClaims",
    "default_license_path",
    "PURCHASE_URL",
]

PREFIX = "KR1"
PURCHASE_URL = "https://keyrescue.example.com/pricing"
_ENV_VAR = "KEYRESCUE_LICENSE"
_SIGNATURE_LEN = 64


@dataclass(frozen=True)
class LicenseClaims:
    """The signed content of a license."""

    id: str
    tier: str
    name: str = ""
    exp: str | None = None          # ISO date, None = perpetual
    seats: int = 1
    issued: str | None = None

    @classmethod
    def from_dict(cls, data: dict) -> "LicenseClaims":
        if not isinstance(data, dict):
            raise LicenseError("license payload is not an object")
        for required in ("id", "tier"):
            if not data.get(required):
                raise LicenseError(f"license payload is missing {required!r}")
        return cls(
            id=str(data["id"]),
            tier=str(data["tier"]).lower(),
            name=str(data.get("name", "")),
            exp=data.get("exp"),
            seats=int(data.get("seats", 1)),
            issued=data.get("issued"),
        )

    def to_dict(self) -> dict:
        data = {"id": self.id, "tier": self.tier}
        if self.name:
            data["name"] = self.name
        if self.exp:
            data["exp"] = self.exp
        if self.seats != 1:
            data["seats"] = self.seats
        if self.issued:
            data["issued"] = self.issued
        return data

    @property
    def expiry_date(self) -> date | None:
        if not self.exp:
            return None
        try:
            return date.fromisoformat(str(self.exp)[:10])
        except ValueError:
            raise LicenseError(f"license has an invalid expiry date {self.exp!r}") from None


@dataclass
class License:
    """A verified license and the limits it grants."""

    claims: LicenseClaims
    tier: Tier
    expired: bool = False
    warning: str = ""
    #: where an activated license was loaded from ("" for the built-in free tier)
    source: str = ""

    @property
    def is_pro(self) -> bool:
        return self.tier.name in ("pro", "team", "trial")

    @property
    def name(self) -> str:
        return self.claims.name or self.claims.id

    def describe(self) -> str:
        lines = [
            f"tier:    {self.tier.label} ({self.tier.name})",
            f"licensed to: {self.name}",
        ]
        if self.claims.exp:
            lines.append(f"expires: {self.claims.exp}")
            if self.expired:
                lines.append("status:  EXPIRED - falling back to Free limits")
        else:
            lines.append("expires: never (perpetual)")
        if self.warning:
            lines.append(f"note:    {self.warning}")
        lines.append("features:")
        lines.extend(f"  - {feature}" for feature in self.tier.features)
        return "\n".join(lines)


def _b32encode(data: bytes) -> str:
    return base64.b32encode(data).decode("ascii").rstrip("=")


def _b32decode(text: str) -> bytes:
    cleaned = "".join(c for c in text if c.isalnum()).upper()
    padding = "=" * (-len(cleaned) % 8)
    try:
        return base64.b32decode(cleaned + padding)
    except Exception as exc:
        raise LicenseError(f"license is not valid base32: {exc}") from None


def encode_license(seed: bytes, claims: LicenseClaims | dict) -> str:
    """Create a license string (vendor side)."""
    payload_dict = claims.to_dict() if isinstance(claims, LicenseClaims) else dict(claims)
    payload = json.dumps(payload_dict, separators=(",", ":"), sort_keys=True).encode("utf-8")
    signature = ed25519.sign(payload, seed)
    return f"{PREFIX}-{_b32encode(payload)}-{_b32encode(signature)}"


def decode_license(text: str) -> tuple[bytes, bytes]:
    """Split a license string into ``(payload, signature)`` without verifying."""
    cleaned = "".join(text.split())
    if cleaned.lower().startswith(PREFIX.lower()):
        cleaned = cleaned[len(PREFIX) + 1 :]
    if "-" not in cleaned:
        raise LicenseError("license key is malformed (expected KR1-<payload>-<signature>)")
    payload_part, _, signature_part = cleaned.rpartition("-")
    payload = _b32decode(payload_part)
    signature = _b32decode(signature_part)
    if len(signature) != _SIGNATURE_LEN:
        raise LicenseError("license signature has the wrong length")
    return payload, signature


def _candidate_public_keys() -> list[bytes]:
    keys = []
    # read through the module so that a build (or an embedder) can install its
    # vendor key at runtime, and so that tests can supply a throwaway key.
    for text in keyring.VENDOR_PUBLIC_KEYS:
        try:
            keys.append(bytes.fromhex(text))
        except ValueError:  # pragma: no cover - misconfiguration
            continue
    if keyring.ALLOW_DEV_KEYS():
        keys.append(bytes.fromhex(keyring.DEV_PUBLIC_KEY))
    return keys


def verify_license(text: str, now: datetime | None = None) -> License:
    """Verify a license string and return it with its limits applied."""
    if not text or not text.strip():
        raise LicenseError("no license key given")
    payload, signature = decode_license(text)

    keys = _candidate_public_keys()
    if not keys:
        raise LicenseError(
            "this build has no vendor public key configured, so licenses cannot be verified. "
            "If you built this from source, run tools/keygen.py and set VENDOR_PUBLIC_KEYS."
        )
    if not any(ed25519.verify(signature, payload, key) for key in keys):
        raise LicenseError(
            "this license key does not verify against this build's vendor key. "
            "Make sure you are using the key that came with your purchase."
        )

    try:
        claims = LicenseClaims.from_dict(json.loads(payload.decode("utf-8")))
    except json.JSONDecodeError as exc:
        raise LicenseError(f"license payload is not valid JSON: {exc}") from None

    tier = get_tier(claims.tier)
    if claims.tier not in ("free", "trial", "pro", "team"):
        raise LicenseError(f"unknown license tier {claims.tier!r}")

    expiry = claims.expiry_date
    today = (now or datetime.now(timezone.utc)).date()
    expired = bool(expiry and expiry < today)
    license_obj = License(claims=claims, tier=tier, expired=expired)
    if expired:
        license_obj.tier = get_tier("free")
        license_obj.warning = f"license expired on {expiry.isoformat()}"
    elif expiry and (expiry - today) <= timedelta(days=30):
        license_obj.warning = f"license expires soon ({expiry.isoformat()})"
    return license_obj


def free_license() -> License:
    return License(claims=LicenseClaims(id="free", tier="free", name="Free tier"), tier=get_tier("free"))


def default_license_path() -> Path:
    override = os.environ.get("KEYRESCUE_LICENSE_PATH")
    if override:
        return Path(override)
    base = os.environ.get("XDG_CONFIG_HOME")
    if base:
        return Path(base) / "keyrescue" / "license.key"
    return Path.home() / ".config" / "keyrescue" / "license.key"


class LicenseStore:
    """Reads/writes the activated license on this machine."""

    def __init__(self, path: Path | None = None):
        self.path = Path(path) if path else default_license_path()

    # ------------------------------------------------------------------ io
    def load_text(self) -> str | None:
        env = os.environ.get(_ENV_VAR)
        if env:
            return env.strip()
        if self.path.exists():
            try:
                text = self.path.read_text(encoding="utf-8").strip()
            except (OSError, UnicodeDecodeError) as exc:
                raise LicenseError(
                    f"the license file {self.path} could not be read "
                    f"({getattr(exc, 'strerror', None) or exc}); delete it or pass --license"
                ) from None
            return text or None
        return None

    def save(self, text: str) -> Path:
        self.path.parent.mkdir(parents=True, exist_ok=True)
        self.path.write_text(text.strip() + "\n", encoding="utf-8")
        try:
            os.chmod(self.path, 0o600)
        except OSError:  # pragma: no cover - platform dependent
            pass
        return self.path

    def remove(self) -> bool:
        if self.path.exists():
            self.path.unlink()
            return True
        return False

    # --------------------------------------------------------------- status
    def source_description(self) -> str:
        """Where ``load_text`` would read from, for diagnostics."""
        if os.environ.get(_ENV_VAR):
            return f"environment variable {_ENV_VAR}"
        return f"file {self.path}"

    def current(self) -> License:
        """The active license: the verified one when present, else the free tier."""
        text = self.load_text()
        if not text:
            return free_license()
        license_obj = verify_license(text)
        license_obj.source = self.source_description()
        return license_obj


def stamp(now: datetime | None = None) -> float:
    return (now or datetime.now(timezone.utc)).timestamp()


def _now_iso() -> str:  # pragma: no cover - cosmetic helper
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


def time_left(license_obj: License) -> timedelta | None:  # pragma: no cover - cosmetic helper
    expiry = license_obj.claims.expiry_date
    if not expiry:
        return None
    return datetime.combine(expiry, datetime.min.time(), tzinfo=timezone.utc) - datetime.now(timezone.utc)


def _self_check() -> bool:  # pragma: no cover - manual smoke test
    seed, public = ed25519.create_keypair()
    message = b"keyrescue"
    return ed25519.verify(ed25519.sign(message, seed), message, public) and time.time() > 0
