"""Bitcoin addresses: encoding, decoding and matching against public keys."""

from __future__ import annotations

from dataclasses import dataclass

from ..errors import InvalidEncoding, InvalidInput
from . import base58, bech32
from .hashes import hash160, sha256, tagged_hash
from .secp256k1 import N, P, parse_pubkey, serialize_point, tweak_add_g, xonly

__all__ = ["AddressInfo", "NETWORKS", "encode_address", "decode_address", "all_addresses", "address_matches_pubkey"]

NETWORKS = {
    "mainnet": {"p2pkh": 0x00, "p2sh": 0x05, "hrp": "bc"},
    "testnet": {"p2pkh": 0x6F, "p2sh": 0xC4, "hrp": "tb"},
    "regtest": {"p2pkh": 0x6F, "p2sh": 0xC4, "hrp": "bcrt"},
}
_SCRIPT_V0 = b"\x00\x14"


@dataclass(frozen=True)
class AddressInfo:
    """A decoded address."""

    kind: str          # p2pkh | p2sh | p2wpkh | p2wsh | p2tr
    payload: bytes     # hash160 for legacy, witness program for segwit
    network: str
    text: str = ""

    @property
    def is_witness(self) -> bool:
        return self.kind in ("p2wpkh", "p2wsh", "p2tr")

    def __str__(self) -> str:  # pragma: no cover - cosmetic
        return f"{self.kind} {self.text or self.payload.hex()}"


def parse_and_serialize(pub: bytes, compressed: bool) -> bytes:
    """Re-serialise ``pub`` in the requested compression, validating it."""
    return serialize_point(parse_pubkey(pub), compressed)


def p2pkh(pub: bytes, network: str = "mainnet") -> str:
    return base58.b58check_encode(bytes([NETWORKS[network]["p2pkh"]]) + hash160(pub))


def p2sh(pub: bytes, compressed: bool = True, network: str = "mainnet") -> str:
    """P2SH-P2WPKH (BIP-49 style nested SegWit) address."""
    program = hash160(parse_and_serialize(pub, compressed))
    redeem = _SCRIPT_V0 + program
    return base58.b58check_encode(bytes([NETWORKS[network]["p2sh"]]) + hash160(redeem))


def p2wpkh(pub: bytes, network: str = "mainnet") -> str:
    program = hash160(parse_and_serialize(pub, True))
    return bech32.encode_segwit_address(NETWORKS[network]["hrp"], 0, program)


def p2tr(pub: bytes, network: str = "mainnet", tweak: bool = True) -> str:
    """Taproot key-path address.

    ``tweak=True`` applies the BIP-341 ``TapTweak`` with an empty script tree,
    which is what a plain single-key Taproot wallet uses.
    """
    point = parse_pubkey(pub)
    if tweak:
        internal = xonly(point)
        scalar = int.from_bytes(tagged_hash("TapTweak", internal), "big")
        if scalar >= N:
            raise InvalidInput("TapTweak scalar is out of range")
        point = tweak_add_g(point, scalar)
        if point[1] & 1:
            point = (point[0], (-point[1]) % P)
    return bech32.encode_segwit_address(NETWORKS[network]["hrp"], 1, xonly(point))


def all_addresses(pub: bytes, network: str = "mainnet") -> dict[str, str]:
    """Every standard address type for a public key (used in reports)."""
    out = {}
    try:
        out["p2pkh (compressed)"] = p2pkh(parse_and_serialize(pub, True), network)
        out["p2pkh (uncompressed)"] = p2pkh(parse_and_serialize(pub, False), network)
    except InvalidInput:
        pass
    try:
        out["p2wpkh"] = p2wpkh(pub, network)
        out["p2sh-p2wpkh"] = p2sh(pub, True, network)
        out["p2tr"] = p2tr(pub, network)
    except InvalidInput:
        pass
    return out


def encode_address(kind: str, payload: bytes, network: str = "mainnet") -> str:
    """Encode a hash160/witness program as the requested address type."""
    kind = kind.lower()
    if kind == "p2pkh":
        return base58.b58check_encode(bytes([NETWORKS[network]["p2pkh"]]) + payload)
    if kind == "p2sh":
        return base58.b58check_encode(bytes([NETWORKS[network]["p2sh"]]) + payload)
    if kind == "p2wpkh":
        return bech32.encode_segwit_address(NETWORKS[network]["hrp"], 0, payload)
    if kind == "p2wsh":
        return bech32.encode_segwit_address(NETWORKS[network]["hrp"], 0, payload)
    if kind == "p2tr":
        return bech32.encode_segwit_address(NETWORKS[network]["hrp"], 1, payload)
    raise InvalidInput(f"unknown address type {kind!r}")


def decode_address(text: str, networks: tuple[str, ...] | None = None) -> AddressInfo:
    """Decode any supported address, identifying its type and network."""
    text = text.strip()
    if not text:
        raise InvalidInput("empty address")

    candidates = networks or ("mainnet", "testnet", "regtest")
    errors: list[str] = []

    for network in candidates:
        cfg = NETWORKS[network]
        hrp = cfg["hrp"]
        if text.lower().startswith(hrp + "1"):
            try:
                _, witver, program = bech32.decode_segwit_address(text, expected_hrp=hrp)
            except InvalidEncoding as exc:
                errors.append(str(exc))
                continue
            if witver == 0:
                kind = "p2wpkh" if len(program) == 20 else "p2wsh"
            elif witver == 1 and len(program) == 32:
                kind = "p2tr"
            else:
                raise InvalidInput(f"unsupported witness version {witver} or program length {len(program)}")
            return AddressInfo(kind, program, network, text)

    try:
        payload = base58.b58check_decode(text)
    except InvalidEncoding as exc:
        raise InvalidEncoding(f"{exc} (also not a supported Bech32 address)") from None

    if len(payload) != 21:
        raise InvalidInput(f"unexpected address payload length {len(payload)}")
    version, program = payload[0], payload[1:]
    for network in candidates:
        cfg = NETWORKS[network]
        if version == cfg["p2pkh"]:
            return AddressInfo("p2pkh", program, network, text)
        if version == cfg["p2sh"]:
            return AddressInfo("p2sh", program, network, text)
    raise InvalidInput(f"unsupported address version byte 0x{version:02x}")


def address_matches_pubkey(addr: str, pub: bytes, info: AddressInfo | None = None) -> bool:
    """Check whether an address belongs to a public key (both encodings tried)."""
    info = info or decode_address(addr)
    try:
        if info.kind == "p2pkh":
            for compressed in (True, False):
                if hash160(parse_and_serialize(pub, compressed)) == info.payload:
                    return True
            return False
        if info.kind == "p2wpkh":
            return hash160(parse_and_serialize(pub, True)) == info.payload
        if info.kind == "p2sh":
            redeem = _SCRIPT_V0 + hash160(parse_and_serialize(pub, True))
            return hash160(redeem) == info.payload
        if info.kind == "p2tr":
            point = parse_pubkey(pub)
            internal = xonly(point)
            scalar = int.from_bytes(tagged_hash("TapTweak", internal), "big")
            tweaked = tweak_add_g(point, scalar)
            return xonly(tweaked) == info.payload
    except InvalidInput:
        return False
    return False


def p2sh_from_redeem_script(script: bytes, network: str = "mainnet") -> str:
    """P2SH address for an arbitrary redeem script."""
    return base58.b58check_encode(bytes([NETWORKS[network]["p2sh"]]) + hash160(script))


def segwit_script_pubkey(witver: int, program: bytes) -> bytes:
    """The scriptPubKey of a SegWit output (``OP_n <program>``)."""
    if not 0 <= witver <= 16:
        raise InvalidInput("witness version must be 0..16")
    opcode = 0x00 if witver == 0 else 0x50 + witver
    return bytes([opcode, len(program)]) + program


def script_pubkey_for_address(address: str) -> bytes:
    """scriptPubKey for any supported address type."""
    info = decode_address(address)
    if info.kind == "p2wpkh":
        return segwit_script_pubkey(0, info.payload)
    if info.kind == "p2wsh":
        return segwit_script_pubkey(0, info.payload)
    if info.kind == "p2tr":
        return segwit_script_pubkey(1, info.payload)
    if info.kind == "p2pkh":
        return b"\x76\xa9\x14" + info.payload + b"\x88\xac"
    if info.kind == "p2sh":
        return b"\xa9\x14" + info.payload + b"\x87"
    raise InvalidInput(f"unsupported address type {info.kind}")


def p2wsh_from_script(script: bytes, network: str = "mainnet") -> str:
    return bech32.encode_segwit_address(NETWORKS[network]["hrp"], 0, sha256(script))
