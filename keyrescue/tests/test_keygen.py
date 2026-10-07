"""The vendor tooling: ``tools/keygen.py`` issues keys the product accepts.

This is the commercial round trip -- create a vendor key pair, mint a license,
verify the signature offline, then activate it and run a real recovery with the
limits that licence grants.  If any of these stop lining up, licences sold to
customers break, so the test drives the tool as a subprocess exactly as a seller
would.
"""

from __future__ import annotations

import json
import subprocess
import sys
from pathlib import Path

import pytest

from keyrescue import cli
from keyrescue.licensing import keys as keyring

ROOT = Path(__file__).resolve().parent.parent
KEYGEN = ROOT / "tools" / "keygen.py"

pytestmark = pytest.mark.skipif(not KEYGEN.exists(), reason="tools/keygen.py is not shipped in the wheel")


def run_tool(*argv, expect=0):
    proc = subprocess.run([sys.executable, str(KEYGEN), *[str(a) for a in argv]],
                          capture_output=True, text=True)
    assert proc.returncode == expect, f"exit {proc.returncode}\n{proc.stdout}\n{proc.stderr}"
    return proc


def test_pair_then_license_then_check(tmp_path):
    out = tmp_path / "vendor"
    run_tool("pair", "--out", out)
    seed_file = out / "vendor.seed"
    public_file = out / "vendor.pub"
    assert seed_file.exists() and public_file.exists()
    assert len(public_file.read_text().strip()) == 64
    if hasattr(seed_file.stat(), "st_mode") and sys.platform != "win32":
        assert oct(seed_file.stat().st_mode & 0o777) == "0o600"

    proc = run_tool("license", "--seed-file", seed_file, "--tier", "pro",
                    "--name", "Jane Doe", "--id", "jane-001")
    key = proc.stdout.strip().splitlines()[0]
    assert key.startswith("KR1-")

    run_tool("check", key, "--public-key", public_file.read_text().strip())
    # a key signed by somebody else must not pass
    run_tool("pair", "--out", tmp_path / "other")
    other = (tmp_path / "other" / "vendor.pub").read_text().strip()
    run_tool("check", key, "--public-key", other, expect=1)
    # and a corrupted key must fail cleanly rather than trace back
    proc = run_tool("check", "not-a-license", "--public-key", public_file.read_text().strip(),
                    expect=1)
    assert proc.stderr.startswith("error:") and "Traceback" not in proc.stderr


def test_same_seed_gives_the_same_key_pair(tmp_path):
    """Re-importing a saved seed must reproduce the key the build was signed with."""
    out_a, out_b = tmp_path / "a", tmp_path / "b"
    first = run_tool("pair", "--out", out_a, "--seed", "11" * 32)
    second = run_tool("pair", "--out", out_b, "--seed", "11" * 32)
    third = run_tool("pair", "--out", tmp_path / "c", "--seed-file", out_a / "vendor.seed")

    def published(proc):
        return proc.stdout.splitlines()[1].strip()

    assert published(first) == published(second) == published(third)
    assert published(first) == (out_a / "vendor.pub").read_text().strip()
    assert (out_a / "vendor.seed").read_text().strip() == "11" * 32


def test_bad_seed_is_reported(tmp_path):
    run_tool("license", "--seed", "abcd", "--tier", "pro", expect=1)
    run_tool("license", "--seed-file", tmp_path / "missing.seed", "--tier", "pro", expect=1)
    bad = tmp_path / "bad.seed"
    bad.write_text("not hex at all", encoding="utf-8")
    run_tool("license", "--seed-file", bad, "--tier", "pro", expect=1)


def test_a_keygen_licence_unlocks_the_cli(tmp_path, monkeypatch, capsys):
    """End to end: a licence sold with keygen is what the product then accepts."""
    out = tmp_path / "vendor"
    run_tool("pair", "--out", out)
    public = (out / "vendor.pub").read_text().strip()
    proc = run_tool("license", "--seed-file", out / "vendor.seed", "--tier", "pro",
                    "--name", "Buyer", "--id", "order-1")
    key = proc.stdout.strip().splitlines()[0]

    # a build whose vendor key matches: activate, then use what the tier grants
    monkeypatch.setattr(keyring, "VENDOR_PUBLIC_KEYS", (public,))
    stored = tmp_path / "license.key"
    monkeypatch.setenv("KEYRESCUE_LICENSE_PATH", str(stored))
    monkeypatch.delenv("KEYRESCUE_LICENSE", raising=False)
    capsys.readouterr()
    assert cli.main(["license", "activate", key]) == 0
    capsys.readouterr()
    assert stored.exists() and stored.read_text().strip() == key
    if hasattr(stored.stat(), "st_mode") and sys.platform != "win32":
        assert oct(stored.stat().st_mode & 0o777) == "0o600"

    code = cli.main(["hex", "-i", "0c28fca386c7a227600b2fe50b7cae11ec86d3bf1fbe471be89827e19d72aa1?",
                     "--target", "1GAehh7TsJAHuUAeKZcXf5CnwuGuGgyX2S", "--threads", "2",
                     "--session", str(tmp_path / "s.json"), "--quiet", "--json"])
    captured = capsys.readouterr()
    assert code == 0
    doc = json.loads(captured.out)
    assert doc["found"] is True
    assert doc["license"] == "pro"
    # sessions and extra threads are licence-gated, so this proves the tier applied
    assert (tmp_path / "s.json").exists()
    assert "ignoring --threads" not in captured.err

    # ... and a build with a different vendor key refuses the very same licence
    monkeypatch.setattr(keyring, "VENDOR_PUBLIC_KEYS", ("ee" * 32,))
    code = cli.main(["license", "show"])
    captured = capsys.readouterr()
    assert code == 3
    assert "does not verify" in captured.err
