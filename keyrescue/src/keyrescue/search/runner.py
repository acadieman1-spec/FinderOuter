"""The parallel search runner.

Engines describe *what* to check; this module decides *how* the keyspace is
walked: chunked across processes, with progress reporting, cooperative
stopping, checkpoints for resume, and a single-process fast path for small
spaces.
"""

from __future__ import annotations

import multiprocessing
import os
import signal
import time
from dataclasses import dataclass, field
from typing import Any, Iterable

from .checkpoint import Session
from .progress import Progress, format_duration, format_rate
from .space import chunk_ranges

__all__ = ["RunConfig", "RunReport", "RecoveryEngine", "run_engine", "default_threads"]

_ENGINE: "RecoveryEngine | None" = None
_SIGNALLED = False


def default_threads() -> int:
    """One worker per CPU, capped so tiny machines stay responsive."""
    return max(1, min(os.cpu_count() or 1, 64))


def _init_worker(engine: "RecoveryEngine") -> None:
    global _ENGINE
    _ENGINE = engine
    try:  # keep Ctrl-C in the parent from spamming worker tracebacks
        signal.signal(signal.SIGINT, signal.SIG_IGN)
    except (ValueError, OSError):  # pragma: no cover - platform dependent
        pass


def _run_chunk(spec: tuple[int, int]) -> tuple[int, int, list[dict]]:
    engine = _ENGINE
    assert engine is not None, "worker was not initialised"
    start, count = spec
    return engine.run_chunk(start, count)


@dataclass
class Match:
    """A candidate that satisfied the engine's check."""

    index: int
    candidate: Any
    detail: dict = field(default_factory=dict)

    def to_dict(self) -> dict:
        return {"index": self.index, "candidate": self.candidate, "detail": self.detail}


@dataclass
class RunConfig:
    """How to execute a search."""

    threads: int = 0                     # 0 = auto
    chunk_size: int = 0                  # 0 = engine default
    max_candidates: int | None = None
    progress: bool = True
    quiet: bool = False
    stop_on_first: bool = True
    session_path: str | None = None
    session: Session | None = None
    checkpoint_interval: float = 5.0
    start_index: int = 0
    dry_run: bool = False

    def resolved_threads(self) -> int:
        return self.threads if self.threads > 0 else default_threads()


@dataclass
class RunReport:
    """Outcome of a search."""

    engine: str
    total: int
    checked: int
    matches: list[Match] = field(default_factory=list)
    elapsed: float = 0.0
    aborted: bool = False        # interrupted by the user (Ctrl-C)
    stopped_early: bool = False  # stopped after a match instead of the whole space
    resumed_from: int = 0
    completed: bool = True
    session_path: str | None = None
    notes: list[str] = field(default_factory=list)

    @property
    def rate(self) -> float:
        return self.checked / self.elapsed if self.elapsed > 0 else 0.0

    @property
    def found(self) -> bool:
        return bool(self.matches)

    def summary(self) -> str:
        parts = [
            f"{self.checked:,} candidates in {format_duration(self.elapsed)}",
            format_rate(self.rate),
        ]
        if self.aborted:
            parts.append("interrupted")
        elif self.stopped_early:
            parts.append("stopped at first match")
        elif not self.completed:
            parts.append("partial")
        return " | ".join(parts)


class RecoveryEngine:
    """Base class for every recovery mode.

    Subclasses build a search space in :meth:`prepare` and implement
    :meth:`check`, which receives one rendered candidate and returns a detail
    dict (a match) or ``None``.
    """

    slug: str = "base"
    title: str = "base engine"
    description: str = ""
    examples: tuple[str, ...] = ()
    #: engines that attack encrypted/derived data ask for an ownership confirmation
    requires_ownership_ack: bool = False
    default_chunk_size: int = 8192
    #: hint used by --estimate before running anything
    cost_per_candidate: float = 5e-6

    def __init__(self, config: RunConfig | None = None):
        self.config = config or RunConfig()
        self.space = None  # type: ignore[assignment]
        self._prepared = False

    # ------------------------------------------------------------- lifecycle
    def prepare(self) -> None:
        """Validate inputs and build the search space. Must set ``self.space``."""
        raise NotImplementedError

    def ensure_prepared(self) -> None:
        if not self._prepared:
            self.prepare()
            self._prepared = True

    def preflight(self) -> bool:
        """Handle an informational flag and skip the search.

        Engines that can print something the user asked for instead of searching
        (``wallet --list-mkeys``) do it here and return ``True``; the runner then
        finishes without applying tier limits, because no keyspace is walked.
        """
        return False

    def describe(self) -> str:
        return f"{self.title}"

    def params(self) -> dict:
        """JSON serialisable description of the run (stored in sessions)."""
        return {}

    # ---------------------------------------------------------------- work
    def render(self, index: int):
        assert self.space is not None
        if self.space.kind == "words":
            return " ".join(self.space.render_words(index))
        return self.space.render(index)

    def check(self, candidate) -> dict | None:
        """Return details for a match, else None."""
        raise NotImplementedError

    def run_chunk(self, start: int, count: int) -> tuple[int, int, list[dict]]:
        """Check ``count`` candidates starting at ``start`` (runs in a worker)."""
        assert self.space is not None
        matches: list[dict] = []
        done = 0
        for index, candidate in self.space.iterate(start, count):
            done += 1
            detail = self.check(candidate)
            if detail is not None:
                matches.append({"index": index, "candidate": candidate, "detail": detail})
        return start, done, matches

    # -------------------------------------------------------------- results
    def result_note(self, match: Match) -> str:
        """Human readable one-liner for a match (printed under the summary)."""
        detail = match.detail
        text = detail.get("message") or detail.get("privkey_hex") or ""
        return f"{match.candidate}: {text}".strip(": ")

    def post_process(self, matches: list[Match]) -> list[str]:
        """Optional extra reporting once the search is over."""
        return []


# --------------------------------------------------------------------------
# Execution
# --------------------------------------------------------------------------


def _make_chunks(total: int, chunk_size: int, start: int) -> Iterable[tuple[int, int]]:
    return chunk_ranges(total, chunk_size, start)


def run_engine(engine: RecoveryEngine, config: RunConfig | None = None) -> RunReport:
    """Run a prepared engine to completion (or until stopped).

    Engines describe the keyspace; this function walks it in chunks.  A single
    process is used for small spaces (or ``--threads 1``), a process pool
    otherwise.  Checkpoints record the lowest not-yet-completed chunk so a
    resumed run never skips work, only repeats a bounded amount of it.
    """
    config = config or engine.config
    engine.config = config
    engine.ensure_prepared()
    space = engine.space
    assert space is not None

    total = space.total
    start = max(0, min(config.start_index, total))
    end = total if config.max_candidates is None else min(total, start + max(1, config.max_candidates))

    chunk_size = config.chunk_size or engine.default_chunk_size
    report = RunReport(engine=engine.slug, total=total, checked=0, resumed_from=start)
    if end <= start:
        report.notes.append("nothing to do: the start index is at the end of the search space")
        return report

    session = config.session
    if session is None and config.session_path:
        session = Session(
            engine=engine.slug,
            params=engine.params(),
            space_signature=space.signature(),
            total=total,
        )

    progress = Progress(
        total=total,
        initial_done=start,
        enabled=config.progress and not config.quiet,
        interval=0.3 if sys_stdout_isatty() else 5.0,
    )

    threads = config.resolved_threads()
    matches: list[Match] = []
    stopped = False
    checked = start
    started = time.monotonic()
    last_checkpoint = started

    def absorb(start_i: int, done_i: int, hits: list[dict]) -> None:
        nonlocal stopped, checked
        for hit in hits:
            match = Match(hit["index"], hit["candidate"], hit["detail"])
            matches.append(match)
            if session is not None:
                session.add_result(match.to_dict())
        checked = max(checked, start_i + done_i)
        progress.update(checked, len(matches))
        if config.stop_on_first and matches:
            stopped = True

    def checkpoint(resume_index: int, elapsed_add: float = 0.0) -> None:
        if not config.session_path or session is None:
            return
        session.next_index = resume_index
        session.total = total
        session.elapsed += elapsed_add
        try:
            session.save(config.session_path)
            report.session_path = config.session_path
        except OSError as exc:  # pragma: no cover - disk problems
            report.notes.append(f"could not write session file: {exc}")

    try:
        if threads <= 1 or (end - start) <= chunk_size:
            for start_i, count_i in _make_chunks(end, chunk_size, start):
                _, done_i, hits = engine.run_chunk(start_i, count_i)
                absorb(start_i, done_i, hits)
                if time.monotonic() - last_checkpoint > config.checkpoint_interval:
                    checkpoint(start_i + done_i)
                    last_checkpoint = time.monotonic()
                if stopped:
                    break
        else:
            methods = multiprocessing.get_all_start_methods()
            context = multiprocessing.get_context("fork" if "fork" in methods else "spawn")
            specs = list(_make_chunks(end, chunk_size, start))
            done_starts: set[int] = set()
            resume_pointer = 0
            with context.Pool(processes=threads, initializer=_init_worker, initargs=(engine,)) as pool:
                results_iter = pool.imap_unordered(_run_chunk, specs, chunksize=1)
                for start_i, done_i, hits in results_iter:
                    done_starts.add(start_i)
                    absorb(start_i, done_i, hits)

                    while resume_pointer < len(specs) and specs[resume_pointer][0] in done_starts:
                        resume_pointer += 1
                    resume_index = specs[resume_pointer][0] if resume_pointer < len(specs) else end

                    if time.monotonic() - last_checkpoint > config.checkpoint_interval:
                        checkpoint(resume_index, time.monotonic() - last_checkpoint)
                        last_checkpoint = time.monotonic()

                    if stopped:
                        pool.terminate()
                        break
    except KeyboardInterrupt:
        report.aborted = True
        if not config.quiet:
            progress.finish("interrupted - saving state")
        checkpoint(checked)

    elapsed = time.monotonic() - started
    report.elapsed = elapsed
    report.checked = max(checked - start, 0)
    report.matches = matches
    report.stopped_early = stopped
    report.completed = report.checked >= (end - start)

    checkpoint(end if report.completed else checked)

    if not config.quiet:
        progress.finish()
    for note in engine.post_process(matches):
        report.notes.append(note)
    return report


def sys_stdout_isatty() -> bool:
    import sys

    return bool(getattr(sys.stderr, "isatty", lambda: False)())


def estimate(engine: RecoveryEngine, seconds_per_candidate: float | None = None) -> str:
    """Human readable estimate for `--estimate`."""
    engine.ensure_prepared()
    space = engine.space
    assert space is not None
    threads = engine.config.resolved_threads()
    cost = seconds_per_candidate or engine.cost_per_candidate
    seconds = space.total * cost / max(threads, 1)
    return (
        f"{space.total:,} candidates\n"
        f"estimated time: {format_duration(seconds)} "
        f"(at {format_rate(1 / cost if cost else 0)} per core, {threads} core(s))"
    )
