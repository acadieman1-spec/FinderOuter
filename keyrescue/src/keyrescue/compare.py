"""What a recovered key is compared against.

A target is the "check" side of a recovery: an address, a public key, a private
key or a bare HASH160.  Matching is arranged so the expensive work (one EC
multiplication) happens at most once per candidate, no matter how many address
formats the target could match.
"""

from __future__ import annotations

from dataclasses import dataclass, field

from .crypto.addresses import AddressInfo, address_matches_pubkey, decode_address
from .crypto.hashes import hash160
from .crypto.secp256k1 import N, parse_pubkey, pubkey_from_privkey, serialize_point, xonly
from .crypto.wif import decode_wif, is_wif
from .errors import InvalidInput, UsageError

__all__ = ["Target", "target_from_string", "ALL_ADDRESS_TYPES"]

ALL_ADDRESS_TYPES = ("p2pkh", "p2sh", "p2wpkh", "p2tr")


@dataclass
class Target:
    """A comparison target for private key candidates."""

    kind: str                      # address kind | pubkey | privkey | hash160
    payload: bytes                 # hash160 / witness program / pubkey / privkey
    address: str = ""              # original text, when the target is an address
    compressed: bool | None = None  # None = accept both encodings
    network: str = "mainnet"
    info: AddressInfo | None = None
    extra: dict = field(default_factory=dict)

    # ------------------------------------------------------------------ build
    @classmethod
    def from_address(cls, text: str, kinds: tuple[str, ...] | None = None) -> "Target":
        info = decode_address(text)
        if kinds and info.kind not in kinds:
            raise InvalidInput(
                f"address {text!r} is {info.kind} but this recovery mode needs one of {', '.join(kinds)}"
            )
        if info.kind in ("p2wsh",):
            raise InvalidInput("P2WSH addresses cannot be matched against a single key")
        compressed = None
        if info.kind in ("p2wpkh", "p2tr"):
            compressed = True
        return cls(kind=info.kind, payload=info.payload, address=text, compressed=compressed,
                   network=info.network, info=info)

    @classmethod
    def from_pubkey(cls, text: str) -> "Target":
        raw = bytes.fromhex(text.strip())
        parse_pubkey(raw)  # validates
        return cls(kind="pubkey", payload=raw, compressed=len(raw) == 33)

    @classmethod
    def from_privkey(cls, text: str) -> "Target":
        if is_wif(text):
            info = decode_wif(text)
            return cls(kind="privkey", payload=info.privkey, compressed=info.compressed)
        raw = bytes.fromhex(text.strip())
        if len(raw) != 32:
            raise InvalidInput("a private key target is 32 bytes of hex or a WIF string")
        key = int.from_bytes(raw, "big")
        if not 1 <= key < N:
            raise InvalidInput("private key target is out of range")
        return cls(kind="privkey", payload=raw)

    @classmethod
    def from_hash160(cls, text: str) -> "Target":
        raw = bytes.fromhex(text.strip())
        if len(raw) != 20:
            raise InvalidInput("a HASH160 target is 20 bytes of hex")
        return cls(kind="hash160", payload=raw)

    @classmethod
    def all_types_for_pubkey(cls, pub: bytes) -> list["Target"]:
        """Every address/representation a public key could have produced."""
        from .crypto.addresses import p2pkh, p2sh, p2tr, p2wpkh

        targets = []
        for compressed in (True, False):
            try:
                text = p2pkh(serialize_point(parse_pubkey(pub), compressed))
                targets.append(cls.from_address(text))
            except InvalidInput:
                pass
        try:
            targets.append(cls.from_address(p2wpkh(serialize_point(parse_pubkey(pub), True))))
            targets.append(cls.from_address(p2sh(serialize_point(parse_pubkey(pub), True))))
            targets.append(cls.from_address(p2tr(serialize_point(parse_pubkey(pub), True))))
        except InvalidInput:
            pass
        return targets

    # ----------------------------------------------------------------- match
    @property
    def expected_key_encodings(self) -> tuple[bool, ...]:
        if self.compressed is None:
            return (True, False)
        return (self.compressed,)

    def _matches_hash160(self, value: int) -> bool:
        """Compare against both public key encodings with a single derivation."""
        from .crypto.secp256k1 import hash160_variants

        compressed_hash, uncompressed_hash = hash160_variants(value)
        return self.payload == compressed_hash or self.payload == uncompressed_hash

    def match_privkey(self, key: bytes | int) -> bool:
        """Check a 32 byte / integer private key against this target."""
        value = key if isinstance(key, int) else int.from_bytes(key, "big")
        if not 1 <= value < N:
            return False

        if self.kind == "privkey":
            return value == int.from_bytes(self.payload, "big")

        if self.kind == "hash160":
            return self._matches_hash160(value)

        if self.kind == "pubkey":
            for compressed in self.expected_key_encodings:
                if pubkey_from_privkey(value, compressed) == self.payload:
                    return True
            return False

        # address targets
        try:
            if self.kind == "p2pkh":
                if len(self.expected_key_encodings) == 2:
                    return self._matches_hash160(value)
                for compressed in self.expected_key_encodings:
                    if hash160(pubkey_from_privkey(value, compressed)) == self.payload:
                        return True
                return False
            point = None
            for compressed in self.expected_key_encodings:
                candidate = pubkey_from_privkey(value, compressed)
                if self.kind in ("p2wpkh", "p2sh"):
                    if address_matches_pubkey(self.address, candidate, self.info):
                        return True
                elif self.kind == "p2tr":
                    if address_matches_pubkey(self.address, candidate, self.info):
                        return True
                point = candidate
            del point
        except InvalidInput:
            return False
        return False

    def describe(self) -> str:
        if self.kind == "privkey":
            return "private key"
        if self.kind == "pubkey":
            return f"public key ({len(self.payload)} bytes)"
        if self.kind == "hash160":
            return "HASH160"
        encoding = "compressed" if self.compressed else ("uncompressed" if self.compressed is False else "any encoding")
        return f"{self.kind} address ({encoding}, {self.network})"

    def to_dict(self) -> dict:
        return {
            "kind": self.kind,
            "target": self.address or self.payload.hex(),
            "compressed": self.compressed,
            "network": self.network,
        }


def target_from_string(text: str, kinds: tuple[str, ...] | None = None) -> Target:
    """Build a target from a user supplied string, detecting its type."""
    text = (text or "").strip()
    if not text:
        raise UsageError("a comparison target is required (address, public key, private key or HASH160)")

    if text.startswith(("bc1", "tb1", "bcrt1", "1", "3", "2", "m", "n")):
        return Target.from_address(text, kinds)
    if is_wif(text):
        return Target.from_privkey(text)
    looks_hex = all(c in "0123456789abcdefABCDEF" for c in text)
    if looks_hex:
        raw = bytes.fromhex(text if len(text) % 2 == 0 else "0" + text)
        if len(raw) == 20:
            return Target.from_hash160(text)
        if len(raw) == 32:
            if kinds and "privkey" not in kinds:
                raise InvalidInput("a 32 byte hex input is ambiguous here; prefix it with 'privkey:'")
            return Target.from_privkey(text)
        if len(raw) in (33, 65):
            return Target.from_pubkey(text)
    raise InvalidInput(
        f"could not recognise the comparison value {text!r} "
        "(expected an address, public key, WIF/hex private key or 20 byte HASH160)"
    )


def xonly_of_pubkey(pub: bytes) -> bytes:
    return xonly(parse_pubkey(pub))
