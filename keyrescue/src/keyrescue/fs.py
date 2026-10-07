"""Filesystem helpers that turn OS errors into user facing errors.

Every path this package reads comes from a command line flag, so a missing or
unreadable file must produce a one line message and a usage exit code -- never a
traceback about ``ENOENT`` on a machine where the user is already stressed about
losing coins.
"""

from __future__ import annotations

from pathlib import Path

from .errors import UsageError

__all__ = ["read_text", "read_bytes"]


def _read(path: str | Path, what: str, binary: bool):
    target = Path(str(path))
    try:
        data = target.read_bytes() if binary else target.read_text(encoding="utf-8")
    except FileNotFoundError:
        raise UsageError(f"{what} {target} does not exist") from None
    except IsADirectoryError:
        raise UsageError(f"{what} {target} is a directory, not a file") from None
    except PermissionError:
        raise UsageError(f"{what} {target} is not readable (permission denied)") from None
    except UnicodeDecodeError as exc:
        raise UsageError(f"{what} {target} is not valid UTF-8 text ({exc.reason})") from None
    except OSError as exc:
        raise UsageError(f"could not read {what} {target}: {exc.strerror or exc}") from None
    if not data:
        raise UsageError(f"{what} {target} is empty")
    return data


def read_text(path: str | Path, what: str = "file") -> str:
    """Read a UTF-8 text file, reporting problems as :class:`UsageError`."""
    return _read(path, what, binary=False)


def read_bytes(path: str | Path, what: str = "file") -> bytes:
    """Read a binary file, reporting problems as :class:`UsageError`."""
    return _read(path, what, binary=True)
