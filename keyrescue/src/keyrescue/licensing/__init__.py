"""License handling for KeyRescue."""

from __future__ import annotations

from .keys import ALLOW_DEV_KEYS, DEV_PUBLIC_KEY, TIERS, Tier, VENDOR_PUBLIC_KEYS, get_tier
from .license import (
    License,
    LicenseClaims,
    LicenseStore,
    PURCHASE_URL,
    decode_license,
    default_license_path,
    encode_license,
    free_license,
    verify_license,
)

__all__ = [
    "License",
    "LicenseClaims",
    "LicenseStore",
    "Tier",
    "TIERS",
    "VENDOR_PUBLIC_KEYS",
    "DEV_PUBLIC_KEY",
    "ALLOW_DEV_KEYS",
    "PURCHASE_URL",
    "decode_license",
    "default_license_path",
    "encode_license",
    "free_license",
    "get_tier",
    "verify_license",
]
