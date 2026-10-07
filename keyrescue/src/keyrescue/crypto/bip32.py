"""BIP-32 hierarchical deterministic key derivation.

Only private (``xprv``) derivation is needed for recovery work, plus the
ability to recognise and search derivation paths.
"""

from __future__ import annotations

import re
from dataclasses import dataclass

from ..errors import InvalidInput
from .hashes import hmac_sha512
from .secp256k1 import N, is_valid_privkey, pubkey_from_privkey

__all__ = [
    "HARDENED",
    "derive_extended",
    "parse_extended_key",
    "MASTER_SECRET",
    "PathComponent",
    "parse_path",
    "path_to_string",
    "master_from_seed",
    "derive_child",
    "derive_path",
    "ExtendedKey",
]

HARDENED = 0x80000000
MASTER_SECRET = b"Bitcoin seed"
_PUBLIC_KEY_VERSION = 0x0488B21E
_PRIVATE_KEY_VERSION = 0x0488ADE4
_TESTNET_EXT_PUB = 0x043587CF
_TESTNET_EXT_PRIV = 0x04358394

_PATH_RE = re.compile(r"^\s*m?\s*(/\s*-?\d+'?h?H?)*\s*$")
_COMPONENT_RE = re.compile(r"^\s*(\d+)\s*('|h|H)?\s*$")

# Popular derivation paths offered by the `path` engine.
POPULAR_PATHS = (
    "m/44'/0'/0'/0/0", "m/44'/0'/0'/0/1", "m/44'/0'/0'/1/0",
    "m/49'/0'/0'/0/0", "m/84'/0'/0'/0/0", "m/86'/0'/0'/0/0",
    "m/0'/0/0", "m/0/0", "m/0'/0'", "m/0'",
    "m/44'/1'/0'/0/0", "m/44'/0'/0'", "m/49'/1'/0'/0/0", "m/84'/1'/0'/0/0",
)


@dataclass(frozen=True)
class PathComponent:
    """One derivation step; ``hardened`` marks index + 2^31."""

    index: int
    hardened: bool

    @property
    def value(self) -> int:
        return self.index + (HARDENED if self.hardened else 0)

    def __str__(self) -> str:  # pragma: no cover - cosmetic
        return f"{self.index}{'h' if self.hardened else ''}"


def parse_path(path: str) -> list[PathComponent]:
    """Parse a BIP-32 path such as ``m/84'/0'/0'/0/0``."""
    if path is None:
        raise InvalidInput("path is required")
    text = path.strip()
    if not text:
        raise InvalidInput("path is empty")
    if text in ("m", "M", "m/"):
        return []
    if not _PATH_RE.match(text):
        raise InvalidInput(f"invalid derivation path {path!r}")
    parts = [p for p in text.replace("m", "", 1).split("/") if p]
    components = []
    for part in parts:
        match = _COMPONENT_RE.match(part)
        if not match:
            raise InvalidInput(f"invalid path component {part!r}")
        index = int(match.group(1))
        hardened = match.group(2) is not None
        if hardened and index >= HARDENED:
            raise InvalidInput(f"path component {part!r} is out of range")
        if index >= HARDENED and not hardened:
            raise InvalidInput(f"path component {part!r} is out of range")
        components.append(PathComponent(index, hardened))
    return components


def path_to_string(components: list[PathComponent]) -> str:
    if not components:
        return "m"
    return "m/" + "/".join(str(c) for c in components)


def master_from_seed(seed: bytes) -> tuple[int, bytes]:
    """BIP-32 master key: ``I = HMAC-SHA512("Bitcoin seed", seed)``."""
    if not 16 <= len(seed) <= 64:
        raise InvalidInput("seed must be 16 to 64 bytes")
    i = hmac_sha512(MASTER_SECRET, seed)
    il, ir = i[:32], i[32:]
    key = int.from_bytes(il, "big")
    if not is_valid_privkey(key):
        raise InvalidInput("derived master key is invalid (retry with a different seed)")
    return key, ir


def derive_child(privkey: int, chaincode: bytes, index: int) -> tuple[int, bytes]:
    """Derive one BIP-32 child private key."""
    if not is_valid_privkey(privkey):
        raise InvalidInput("parent private key is out of range")
    if not 0 <= index < 2**32:
        raise InvalidInput("child index must be below 2^32")
    if index & HARDENED:
        data = b"\x00" + privkey.to_bytes(32, "big") + index.to_bytes(4, "big")
    else:
        data = pubkey_from_privkey(privkey, True) + index.to_bytes(4, "big")
    i = hmac_sha512(chaincode, data)
    il = int.from_bytes(i[:32], "big")
    child = (il + privkey) % N
    if il >= N or not is_valid_privkey(child):
        raise InvalidInput("derived child key is invalid (index skipped)")
    return child, i[32:]


def derive_path(seed: bytes, path: str | list[PathComponent]) -> tuple[int, bytes]:
    """Derive the key and chain code at ``path`` for a seed."""
    components = parse_path(path) if isinstance(path, str) else path
    key, chain = master_from_seed(seed)
    for component in components:
        key, chain = derive_child(key, chain, component.value)
    return key, chain


def derive_path_privkey(seed: bytes, path: str | list[PathComponent]) -> int:
    return derive_path(seed, path)[0]


def derive_extended(seed: bytes, path: str | list[PathComponent], private: bool = True) -> "ExtendedKey":
    """Derive an extended key at ``path`` with the metadata needed to serialise it."""
    from .hashes import hash160

    components = parse_path(path) if isinstance(path, str) else list(path)
    key, chain = master_from_seed(seed)
    fingerprint = b"\x00\x00\x00\x00"
    child_number = 0
    for component in components:
        parent_pub = pubkey_from_privkey(key, True)
        fingerprint = hash160(parent_pub)[:4]
        key, chain = derive_child(key, chain, component.value)
        child_number = component.value
    return ExtendedKey(
        key=key,
        chaincode=chain,
        depth=len(components),
        parent_fingerprint=fingerprint,
        child_number=child_number,
        private=private,
        pubkey=None if private else pubkey_from_privkey(key, True),
    )


def parse_extended_key(text: str) -> "ExtendedKey":
    """Parse an xprv/xpub (and testnet tprv/tpub) string."""
    from . import base58

    payload = base58.b58check_decode(text.strip())
    if len(payload) != 78:
        raise InvalidInput("an extended key payload is 78 bytes")
    version = int.from_bytes(payload[0:4], "big")
    if version in (_PRIVATE_KEY_VERSION, _TESTNET_EXT_PRIV):
        private = True
    elif version in (_PUBLIC_KEY_VERSION, _TESTNET_EXT_PUB):
        private = False
    else:
        raise InvalidInput(f"unknown extended key version 0x{version:08x}")
    key_bytes = payload[45:78]
    if private:
        if key_bytes[0] != 0:
            raise InvalidInput("private extended key must be padded with a zero byte")
        key = int.from_bytes(key_bytes[1:], "big")
        if not is_valid_privkey(key):
            raise InvalidInput("extended private key is out of range")
    else:
        from .secp256k1 import parse_pubkey

        try:
            parse_pubkey(key_bytes)
        except Exception:
            raise InvalidInput("extended public key is not a valid curve point") from None
        key = int.from_bytes(key_bytes, "big")
    return ExtendedKey(
        key=key,
        chaincode=payload[13:45],
        depth=payload[4],
        parent_fingerprint=payload[5:9],
        child_number=int.from_bytes(payload[9:13], "big"),
        private=private,
        testnet=version in (_TESTNET_EXT_PRIV, _TESTNET_EXT_PUB),
        pubkey_compressed=len(key_bytes) == 33,
        pubkey=None if private else key_bytes,
    )


@dataclass(frozen=True)
class ExtendedKey:
    """A serialised extended key (xprv/xpub and their testnet twins)."""

    key: int
    chaincode: bytes
    depth: int = 0
    parent_fingerprint: bytes = b"\x00\x00\x00\x00"
    child_number: int = 0
    private: bool = True
    testnet: bool = False
    pubkey_compressed: bool = True
    #: serialised public key, when it is known without the private scalar
    #: (this is what an xpub/tpub carries)
    pubkey: bytes | None = None

    @property
    def public_key(self) -> bytes:
        """The public key this extended key describes, compressed form."""
        if self.pubkey is not None:
            return self.pubkey
        return pubkey_from_privkey(self.key, True)

    def fingerprint(self) -> bytes:
        """hash160 of this key's public key, first four bytes (BIP-32 ``FingerPrint``)."""
        from .hashes import hash160

        return hash160(self.public_key)[:4]

    def serialize(self) -> str:
        from . import base58
        from .hashes import hash160

        if self.private:
            version = _TESTNET_EXT_PRIV if self.testnet else _PRIVATE_KEY_VERSION
            payload = b"\x00" + self.key.to_bytes(32, "big")
        else:
            version = _TESTNET_EXT_PUB if self.testnet else _PUBLIC_KEY_VERSION
            if self.pubkey is not None:
                payload = self.pubkey
            else:
                # a public extended key parsed from text stores the point itself
                # in ``key``; only a derived one still holds the private scalar
                payload = (
                    self.key.to_bytes(33, "big")
                    if (self.key >> 256) in (2, 3)
                    else pubkey_from_privkey(self.key, self.pubkey_compressed)
                )
        body = (
            version.to_bytes(4, "big")
            + bytes([self.depth])
            + self.parent_fingerprint
            + self.child_number.to_bytes(4, "big")
            + self.chaincode
            + payload
        )
        text = base58.b58check_encode(body)
        _ = hash160(payload)  # keep the import meaningful for future fingerprints
        return text
