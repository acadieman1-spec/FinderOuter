"""Session checkpoints so multi-hour searches can be resumed.

Sessions are JSON files written atomically.  A session stores the engine, the
engine's parameters, a fingerprint of the search space and the keyspace index
from which the search should continue.  Unknown fields are preserved so that
newer sessions keep working with older builds where possible.
"""

from __future__ import annotations

import json
import os
import time
from dataclasses import dataclass, field
from pathlib import Path

from ..errors import InvalidInput

__all__ = ["Session", "load_session", "save_session", "DEFAULT_SESSION_NAME"]

DEFAULT_SESSION_NAME = "keyrescue.session.json"
FORMAT_VERSION = 1


@dataclass
class Session:
    """A resumable search."""

    engine: str
    params: dict
    space_signature: str
    next_index: int = 0
    total: int = 0
    results: list[dict] = field(default_factory=list)
    started_at: float = field(default_factory=time.time)
    updated_at: float = field(default_factory=time.time)
    elapsed: float = 0.0
    format_version: int = FORMAT_VERSION
    extra: dict = field(default_factory=dict)

    # ------------------------------------------------------------------ io
    def to_dict(self) -> dict:
        data = {
            "format_version": self.format_version,
            "engine": self.engine,
            "params": self.params,
            "space_signature": self.space_signature,
            "next_index": self.next_index,
            "total": self.total,
            "results": self.results,
            "started_at": self.started_at,
            "updated_at": time.time(),
            "elapsed": self.elapsed,
        }
        data.update(self.extra)
        return data

    def save(self, path: str | os.PathLike) -> Path:
        target = Path(path)
        target.parent.mkdir(parents=True, exist_ok=True)
        tmp = target.with_suffix(target.suffix + ".tmp")
        tmp.write_text(json.dumps(self.to_dict(), indent=2), encoding="utf-8")
        os.replace(tmp, target)
        return target

    @classmethod
    def from_dict(cls, data: dict) -> "Session":
        known = {
            "format_version", "engine", "params", "space_signature", "next_index",
            "total", "results", "started_at", "updated_at", "elapsed",
        }
        extra = {k: v for k, v in data.items() if k not in known}
        session = cls(
            engine=data["engine"],
            params=data.get("params", {}),
            space_signature=data.get("space_signature", ""),
            next_index=int(data.get("next_index", 0)),
            total=int(data.get("total", 0)),
            results=list(data.get("results", [])),
            started_at=float(data.get("started_at", time.time())),
            updated_at=float(data.get("updated_at", 0)),
            elapsed=float(data.get("elapsed", 0.0)),
            format_version=int(data.get("format_version", FORMAT_VERSION)),
            extra=extra,
        )
        if session.format_version > FORMAT_VERSION:
            raise InvalidInput(
                f"session was written by a newer version (format {session.format_version})"
            )
        return session

    def matches(self, engine: str, space_signature: str) -> bool:
        """True when the session describes the same search as the current run."""
        return self.engine == engine and self.space_signature == space_signature

    def add_result(self, result: dict) -> None:
        self.results.append(result)


def save_session(session: Session, path: str | os.PathLike) -> Path:
    return session.save(path)


def load_session(path: str | os.PathLike) -> Session:
    target = Path(path)
    if not target.exists():
        raise InvalidInput(f"session file {target} does not exist")
    try:
        data = json.loads(target.read_text(encoding="utf-8"))
    except json.JSONDecodeError as exc:
        raise InvalidInput(f"session file {target} is not valid JSON: {exc}") from None
    if not isinstance(data, dict):
        raise InvalidInput(f"session file {target} does not contain a session object")
    return Session.from_dict(data)
