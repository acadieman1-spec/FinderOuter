"""Shared fixtures.

The suite runs against the source tree, so ``src`` is added to ``sys.path``
when KeyRescue has not been pip-installed.  Specification vectors live in
``tests/vectors`` as JSON: they are copied out of the upstream documents by
``tools/fetch_spec_vectors.py`` (or transcribed, where a document is prose) so
that the tests themselves never need network access.
"""

from __future__ import annotations

import json
import sys
from functools import lru_cache
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
SRC = ROOT / "src"
VECTORS = Path(__file__).resolve().parent / "vectors"

if SRC.exists() and str(SRC) not in sys.path:
    sys.path.insert(0, str(SRC))


@lru_cache(maxsize=None)
def _load(name: str) -> dict:
    return json.loads((VECTORS / f"{name}.json").read_text(encoding="utf-8"))


def vectors(name: str) -> dict:
    """A vector file from ``tests/vectors`` (``bip32``, ``bip39``, ``bip38``, ...)."""
    try:
        return _load(name)
    except FileNotFoundError:
        raise FileNotFoundError(
            f"missing test vector file tests/vectors/{name}.json -- regenerate with "
            f"python tools/fetch_spec_vectors.py (needs network)"
        ) from None


import pytest  # noqa: E402


@pytest.fixture(scope="session")
def bip32_vectors():
    return vectors("bip32")


@pytest.fixture(scope="session")
def bip39_vectors():
    return vectors("bip39")


@pytest.fixture(scope="session")
def bech32_vectors():
    return vectors("bech32")


@pytest.fixture(scope="session")
def bip38_vectors():
    return vectors("bip38")


@pytest.fixture(scope="session")
def minikey_vectors():
    return vectors("minikey")
