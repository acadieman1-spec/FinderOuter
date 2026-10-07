"""Progress reporting for long searches.

Two modes: an in-place status line when stdout is a terminal (with keys/sec and
ETA), and periodic plain lines otherwise so logs and CI output stay readable.
Everything is written to stderr so results on stdout stay machine parsable.
"""

from __future__ import annotations

import shutil
import sys
import time

__all__ = ["Progress", "format_duration", "format_rate"]


def format_duration(seconds: float) -> str:
    """Human readable duration (``1h 04m 12s``)."""
    if seconds is None or seconds != seconds or seconds < 0:
        return "unknown"
    seconds = int(seconds)
    if seconds < 60:
        return f"{seconds}s"
    minutes, sec = divmod(seconds, 60)
    hours, minutes = divmod(minutes, 60)
    days, hours = divmod(hours, 24)
    if days:
        return f"{days}d {hours:02d}h {minutes:02d}m"
    if hours:
        return f"{hours}h {minutes:02d}m {sec:02d}s"
    return f"{minutes}m {sec:02d}s"


def format_rate(rate: float) -> str:
    """Human readable rate (``12.3 k/s``)."""
    if rate <= 0:
        return "0/s"
    for unit, factor in (("M", 1_000_000), ("k", 1_000)):
        if rate >= factor:
            return f"{rate / factor:.2f} {unit}/s"
    return f"{rate:.1f}/s"


class Progress:
    """Tracks completed work and renders it.

    ``total`` may be ``0`` (unknown) in which case only a counter is shown.
    """

    def __init__(self, total: int, initial_done: int = 0, stream=None, enabled: bool = True,
                 interval: float = 0.25):
        self.total = total
        self.initial_done = initial_done
        self.stream = stream or sys.stderr
        self.enabled = enabled
        self.interval = interval
        self.start_time = time.monotonic()
        self.last_render = 0.0
        self.done = initial_done
        self.found = 0
        self._is_tty = bool(getattr(self.stream, "isatty", lambda: False)())
        self._last_line_len = 0

    # ------------------------------------------------------------------ state
    @property
    def elapsed(self) -> float:
        return max(time.monotonic() - self.start_time, 1e-9)

    @property
    def rate(self) -> float:
        worked = self.done - self.initial_done
        return worked / self.elapsed if worked > 0 else 0.0

    @property
    def eta(self) -> float | None:
        if not self.total or self.done <= 0:
            return None
        remaining = max(self.total - self.done, 0)
        return remaining / self.rate if self.rate else None

    @property
    def percent(self) -> float:
        return (self.done / self.total * 100.0) if self.total else 0.0

    def update(self, done: int, found: int = 0) -> None:
        self.done = done
        self.found = found
        now = time.monotonic()
        if not self.enabled:
            return
        if now - self.last_render >= self.interval:
            self.last_render = now
            self.render()

    def render(self, force: bool = False) -> None:
        if not self.enabled and not force:
            return
        if self.total:
            bar_width = max(shutil.get_terminal_size((100, 24)).columns - 52, 10)
            filled = int(bar_width * min(self.percent, 100.0) / 100.0)
            bar = "#" * filled + "-" * (bar_width - filled)
            line = f"[{bar}] {self.percent:5.1f}%  {self.done:,}/{self.total:,}"
        else:
            line = f"{self.done:,} candidates"
        line += f"  {format_rate(self.rate)}"
        if self.total:
            line += f"  ETA {format_duration(self.eta)}"
        if self.found:
            line += f"  ({self.found} found)"

        if self._is_tty:
            padding = max(self._last_line_len - len(line), 0)
            self.stream.write("\r" + line + " " * padding)
            self.stream.flush()
            self._last_line_len = len(line)
        else:
            self.stream.write(line + "\n")
            self.stream.flush()

    def finish(self, message: str = "") -> None:
        if self._is_tty and self.enabled:
            self.stream.write("\r" + " " * self._last_line_len + "\r")
            self.stream.flush()
            self._last_line_len = 0
        if message:
            self.stream.write(message + "\n")
            self.stream.flush()

    def __enter__(self) -> "Progress":
        return self

    def __exit__(self, *exc) -> None:
        self.finish()
