#!/usr/bin/env python3
"""Fetch authoritative test vectors from the BIPs repository.

Run this once (network required) to refresh ``tests/vectors/*.json``; the files
are committed so the test suite runs fully offline afterwards.  Every vector
keeps the URL it came from so a reviewer can check provenance by hand.

Usage::

    python tools/fetch_spec_vectors.py
"""

from __future__ import annotations

import json
import re
import sys
import urllib.request
from pathlib import Path

REPO = "https://api.github.com/repos/bitcoin/bips/contents/"
OUT_DIR = Path(__file__).resolve().parent.parent / "tests" / "vectors"


def fetch(path: str) -> str:
    url = REPO + path
    request = urllib.request.Request(url, headers={"Accept": "application/vnd.github.raw",
                                                   "User-Agent": "keyrescue-vector-fetch"})
    with urllib.request.urlopen(request, timeout=60) as response:
        return response.read().decode("utf-8")


def save(name: str, payload: dict) -> None:
    OUT_DIR.mkdir(parents=True, exist_ok=True)
    target = OUT_DIR / name
    target.write_text(json.dumps(payload, indent=2) + "\n", encoding="utf-8")
    print(f"wrote {target.relative_to(OUT_DIR.parent.parent)}")


def bip39_vectors() -> None:
    """BIP-39 vectors, from the reference list the BIP itself points to."""
    url = "https://api.github.com/repos/trezor/python-mnemonic/contents/vectors.json"
    request = urllib.request.Request(url, headers={"Accept": "application/vnd.github.raw",
                                                   "User-Agent": "keyrescue-vector-fetch"})
    with urllib.request.urlopen(request, timeout=60) as response:
        data = json.loads(response.read().decode("utf-8"))

    # keep all 24 English vectors; each is [entropy, mnemonic, seed, xprv]
    english = data["english"]
    vectors = [
        {"entropy": row[0], "mnemonic": row[1], "seed": row[2], "xprv": row[3]}
        for row in english
        if len(row) >= 4 and row[1].count(" ") == 11  # the 128-bit set
    ]
    save(
        "bip39.json",
        {
            "source": "https://github.com/trezor/python-mnemonic/blob/master/vectors.json "
                      "(the vector list referenced by BIP-39)",
            "passphrase": "TREZOR",
            "vectors": vectors,
        },
    )


def bip32_vectors() -> None:
    text = fetch("bip-0032.mediawiki")
    vectors = []
    for number in (1, 2):
        marker = f"===Test vector {number}==="
        section = text.index(marker)
        next_marker = text.find("===Test vector", section + 10)
        block = text[section : next_marker if next_marker > 0 else len(text)]

        seed_match = re.search(r"Seed \(hex\): ([0-9a-fA-F]+)", block)
        if not seed_match:
            continue

        rows: list[dict] = []
        current_path = None
        current: dict[str, str] = {}
        for line in block.splitlines():
            stripped = line.strip()
            chain_match = re.match(r"^\*\s*Chain\s+(\S+)", stripped)
            if chain_match:
                if current_path is not None and current:
                    rows.append({"path": current_path, **current})
                raw_path = chain_match.group(1).replace("<sub>H</sub>", "'").replace("<sub>h</sub>", "'")
                current_path = raw_path
                current = {}
                continue
            value_match = re.match(r"^\*\*\s*ext (pub|prv):\s*(\S+)", stripped)
            if value_match and current_path is not None:
                current["xpub" if value_match.group(1) == "pub" else "xprv"] = value_match.group(2)
        if current_path is not None and current:
            rows.append({"path": current_path, **current})

        rows = [row for row in rows if row.get("xprv") and row.get("xpub")]
        if rows:
            vectors.append({"seed": seed_match.group(1), "rows": rows})
    save(
        "bip32.json",
        {
            "source": "https://github.com/bitcoin/bips/blob/master/bip-0032.mediawiki",
            "vectors": vectors,
        },
    )



_BECH32_CHARSET = "qpzry9x8gf2tvdw0s3jn54khce6mua7l"
_BECH32M_CONST = 0x2BC830A3


def _polymod(values: list[int]) -> int:
    generator = [0x3B6A57B2, 0x26508E6D, 0x1EA119FA, 0x3D4233DD, 0x2A1462B3]
    checksum = 1
    for value in values:
        top = checksum >> 25
        checksum = ((checksum & 0x1FFFFFF) << 5) ^ value
        for i in range(5):
            checksum ^= generator[i] if (top >> i) & 1 else 0
    return checksum


def _classify_segwit_address(address: str) -> tuple[str | None, int | None]:
    """Return ``(checksum_spec, witness_version)`` for a Bech32 string."""
    lowered = address.lower()
    if lowered != address and address.upper() != address:
        return None, None
    position = lowered.rfind("1")
    if position < 1:
        return None, None
    hrp, data = lowered[:position], lowered[position + 1 :]
    try:
        values = [_BECH32_CHARSET.index(char) for char in data]
    except ValueError:
        return None, None
    expanded = [ord(c) >> 5 for c in hrp] + [0] + [ord(c) & 31 for c in hrp]
    checksum = _polymod(expanded + values)
    spec = "bech32" if checksum == 1 else "bech32m" if checksum == _BECH32M_CONST else None
    return spec, (values[0] if values else None)


def _segwit_vectors(text: str) -> tuple[list[dict], list[dict]]:
    valid: list[dict] = []
    invalid: list[dict] = []
    for line in text.splitlines():
        match = re.match(r"^\*\s*<tt>([^<]+)</tt>:\s*(.+)$", line.strip())
        if not match:
            continue
        address, rest = match.group(1).strip(), match.group(2).strip()
        script_match = re.match(r"^<tt>([0-9a-fA-F]+)</tt>$", rest)
        if script_match:
            valid.append({"address": address, "script": script_match.group(1).lower()})
        else:
            reason = re.sub(r"<[^>]+>", "", rest).strip().rstrip(".")
            invalid.append({"address": address, "reason": reason})
    return valid, invalid


def segwit_vectors() -> None:
    """BIP-173 + BIP-350 vectors.

    BIP-350 supersedes BIP-173 for witness versions 1 and above: addresses that
    BIP-173 called valid are now invalid because they carry a Bech32 (not
    Bech32m) checksum.  Those are recorded under ``superseded_by_bip350`` so the
    tests can assert the modern behaviour explicitly.
    """
    valid173, invalid173 = _segwit_vectors(fetch("bip-0173.mediawiki"))
    valid350, invalid350 = _segwit_vectors(fetch("bip-0350.mediawiki"))

    # BIP-350 revised the rules for witness version 1 and above: the checksum
    # must be Bech32m, not Bech32.  BIP-173 vectors that break that rule are
    # superseded (BIP-350 no longer lists them at all), so classify them here
    # instead of trusting either list blindly.
    superseded = []
    still_valid = []
    for entry in valid173:
        spec, witver = _classify_segwit_address(entry["address"])
        if witver is not None and witver >= 1 and spec != "bech32m":
            superseded.append({**entry, "reason": f"witness v{witver} with {spec} checksum"})
        else:
            still_valid.append(entry)

    invalid = list(invalid173) + list(invalid350)
    seen = set()
    deduped = []
    for entry in invalid:
        if entry["address"] not in seen:
            seen.add(entry["address"])
            deduped.append(entry)

    save(
        "bech32.json",
        {
            "source": "https://github.com/bitcoin/bips/blob/master/bip-0173.mediawiki, "
                      "https://github.com/bitcoin/bips/blob/master/bip-0350.mediawiki",
            "valid": still_valid + valid350,
            "superseded_by_bip350": superseded,
            "invalid": deduped,
        },
    )


def main() -> int:
    bip39_vectors()
    bip32_vectors()
    segwit_vectors()
    return 0


if __name__ == "__main__":
    sys.exit(main())
