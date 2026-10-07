"""Errors and exit codes shared by the whole package."""

from __future__ import annotations

__all__ = [
    "KeyRescueError",
    "UsageError",
    "InvalidEncoding",
    "InvalidInput",
    "UnsupportedInput",
    "BackendError",
    "LicenseError",
    "SearchAborted",
    "EXIT_OK",
    "EXIT_NO_RESULT",
    "EXIT_USAGE",
    "EXIT_LICENSE",
    "EXIT_INTERRUPTED",
]


class KeyRescueError(Exception):
    """Base class for every error the tool reports to the user."""


class UsageError(KeyRescueError):
    """The user invoked the tool incorrectly."""


class InvalidEncoding(KeyRescueError):
    """An encoded string (Base-58, Bech32, hex, ...) could not be decoded."""


class InvalidInput(KeyRescueError):
    """Input is well formed but not usable for the requested operation."""


class UnsupportedInput(KeyRescueError):
    """Input is understood but this build cannot handle it."""


class BackendError(KeyRescueError):
    """A required native/optional backend is missing or misbehaving."""


class LicenseError(KeyRescueError):
    """A license key is missing, malformed, expired or does not verify."""


class SearchAborted(KeyRescueError):
    """The search was interrupted (signal, checkpoint resume point, ...)."""


# Exit codes -- stable contract for scripting around the CLI.
EXIT_OK = 0
EXIT_NO_RESULT = 1
EXIT_USAGE = 2
EXIT_LICENSE = 3
EXIT_INTERRUPTED = 130
