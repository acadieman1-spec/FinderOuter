"""Backend selection shared by the crypto modules.

KeyRescue prefers an accelerator when one is installed (libsecp256k1 through
coincurve, AES through pycryptodome, RIPEMD-160 through OpenSSL) and falls back to
its own pure Python implementation otherwise.  The fallback is the code path a bare
``pip install keyrescue`` actually runs, so it has to be testable on a machine that
*happens* to have the accelerators installed.  Setting ``KEYRESCUE_BACKEND=pure``
does exactly that:

    KEYRESCUE_BACKEND=pure pytest        # exercise the stdlib-only paths
    KEYRESCUE_BACKEND=pure keyrescue doctor

``BACKENDS`` is what ``keyrescue doctor`` prints, and is also used by the tests to
report which combination they covered.
"""

from __future__ import annotations

import os

__all__ = ["prefer_pure_python", "ENV_VAR"]

ENV_VAR = "KEYRESCUE_BACKEND"

_TRUTHY = ("pure", "python", "stdlib", "fallback", "1", "true", "yes", "on")


def prefer_pure_python() -> bool:
    """True when the caller should skip every optional accelerator."""
    return os.environ.get(ENV_VAR, "").strip().lower() in _TRUTHY
