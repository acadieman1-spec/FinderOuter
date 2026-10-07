"""Result reporting: human readable text and machine readable JSON."""

from __future__ import annotations

import json
from datetime import datetime, timezone
from pathlib import Path

from .search.runner import RunReport
from .version import __version__

__all__ = ["build_payload", "render_text", "render_json", "write_report", "SECRET_KEYS"]

#: detail keys that are written to the terminal but not into reports unless
#: ``--include-secrets`` is given, so a shared JSON never leaks a private key
SECRET_KEYS = ("privkey_hex", "master_key_hex", "wif_compressed", "wif_uncompressed", "passphrase", "password")


def build_payload(report: RunReport, engine=None, include_secrets: bool = False, extra: dict | None = None) -> dict:
    results = []
    for match in report.matches:
        detail = dict(match.detail)
        if not include_secrets:
            for key in SECRET_KEYS:
                detail.pop(key, None)
        results.append(
            {
                "candidate": match.candidate,
                "index": match.index,
                "detail": detail,
            }
        )
    payload = {
        "tool": "keyrescue",
        "version": __version__,
        "mode": report.engine,
        "generated_at": datetime.now(timezone.utc).isoformat(timespec="seconds"),
        "search": {
            "total_candidates": report.total,
            "checked": report.checked,
            "resumed_from": report.resumed_from,
            "elapsed_seconds": round(report.elapsed, 4),
            "rate_per_second": round(report.rate, 2),
            "completed": report.completed,
            "aborted": report.aborted,
            "stopped_early": report.stopped_early,
            "session": report.session_path,
        },
        "found": report.found,
        "results": results,
        "notes": report.notes,
    }
    if engine is not None:
        try:
            payload["engine"] = {"slug": engine.slug, "title": engine.title, "params": engine.params()}
        except Exception:  # pragma: no cover - params must never break reporting
            payload["engine"] = {"slug": getattr(engine, "slug", report.engine)}
    if extra:
        payload.update(extra)
    return payload


def render_json(report: RunReport, engine=None, include_secrets: bool = False, extra: dict | None = None) -> str:
    return json.dumps(build_payload(report, engine, include_secrets, extra), indent=2, sort_keys=False)


def render_text(report: RunReport, engine=None) -> str:
    lines: list[str] = []
    if report.found:
        lines.append("")
        lines.append("=" * 72)
        lines.append(f"  RECOVERED ({len(report.matches)} match{'es' if len(report.matches) != 1 else ''})")
        lines.append("=" * 72)
        for match in report.matches:
            lines.append("")
            if engine is not None:
                lines.append(engine.result_note(match))
            detail = dict(match.detail)
            message = detail.pop("message", "")
            if message and engine is None:
                lines.append(message)
            for key, value in detail.items():
                label = key.replace("_", " ")
                lines.append(f"    {label:<24} {value}")
        lines.append("")
    else:
        lines.append("")
        lines.append("No match found.")

    lines.append("-" * 72)
    lines.append(f"checked {report.checked:,} of {report.total:,} candidates in {report.elapsed:.1f}s")
    if report.session_path:
        lines.append(f"session saved: {report.session_path}")
        if not report.completed:
            lines.append(f"resume with: --session {report.session_path} --resume")
    for note in report.notes:
        lines.append(f"note: {note}")
    return "\n".join(lines)


def write_report(path: str | Path, report: RunReport, engine=None, as_json: bool | None = None,
                 include_secrets: bool = False) -> Path:
    target = Path(path)
    if as_json is None:
        as_json = target.suffix.lower() in (".json", "")
    target.parent.mkdir(parents=True, exist_ok=True)
    if as_json:
        target.write_text(render_json(report, engine, include_secrets) + "\n", encoding="utf-8")
    else:
        target.write_text(render_text(report, engine) + "\n", encoding="utf-8")
    return target
