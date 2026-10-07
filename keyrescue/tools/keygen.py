#!/usr/bin/env python3
"""Vendor tooling: create the signing key pair and mint license keys.

This file ships in the repository, **not** in the built wheel: customers get the
product, the signing key stays with you.  Never run ``keygen.py pair`` on a
machine that is connected to the internet long-term, and never commit the seed.

Two commands::

    # 1. once, offline: create the vendor key pair
    python tools/keygen.py pair --out ~/keyrescue-vendor
    #    -> put the printed public key into licensing/keys.py VENDOR_PUBLIC_KEYS

    # 2. per customer: mint a license key
    python tools/keygen.py license --seed-file ~/keyrescue-vendor/vendor.seed \\
        --tier pro --name "Jane Doe" --id jane-2026-10-07
    #    -> send the printed KR1-... string to the customer

The customer then runs ``keyrescue license activate "KR1-..."`` and every later
run verifies the signature locally, so activation works fully offline.

``license --dev`` (or ``pair --dev``) prints a development key pair that the
test suite and the README examples use; licenses signed with it are ignored
unless ``KEYRESCUE_ALLOW_DEV_KEYS=1`` is set, which is what keeps a development
key from working in a customer build.
"""

from __future__ import annotations

import argparse
import getpass
import os
import sys
from datetime import date, timedelta
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "src"))

from keyrescue.licensing import ed25519  # noqa: E402
from keyrescue.licensing.license import encode_license  # noqa: E402

TIERS = ("free", "trial", "pro", "team")


# --------------------------------------------------------------------- helpers
def _write_private(path: Path, text: str) -> None:
    """Write the seed as hex (the format ``--seed-file`` reads back) with 0600."""
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(text.rstrip("\n") + "\n", encoding="utf-8")
    if os.name != "nt":
        os.chmod(path, 0o600)


def _read_seed(args) -> bytes:
    if args.seed:
        seed = bytes.fromhex(args.seed.strip())
    elif args.seed_file:
        path = Path(args.seed_file)
        if not path.exists():
            sys.exit(f"error: no seed file at {path}")
        text = path.read_text(encoding="utf-8").strip()
        try:
            seed = bytes.fromhex(text)
        except ValueError:
            sys.exit(f"error: {path} must contain 32 bytes as hex")
    else:
        sys.exit("error: pass --seed-file or --seed")
    if len(seed) != ed25519.SEED_SIZE:
        sys.exit(f"error: the seed must be {ed25519.SEED_SIZE} bytes ({len(seed)} given)")
    return seed


def _print_snippet(public: bytes, out_dir: Path | None) -> None:
    print("public key (this is what goes into the build):")
    print(f"  {public.hex()}")
    print()
    print("paste into src/keyrescue/licensing/keys.py:")
    print("  VENDOR_PUBLIC_KEYS: tuple[str, ...] = (")
    print(f'      "{public.hex()}",')
    print("  )")
    print()
    if out_dir is not None:
        print(f"private seed written to {out_dir / 'vendor.seed'} (keep this offline, back it up)")
    print("a lost signing key means you cannot issue licenses that this build accepts;")
    print("keep a second public key in VENDOR_PUBLIC_KEYS if you want a rotation path.")


# ---------------------------------------------------------------------- commands
def cmd_pair(args) -> int:
    if sum(bool(value) for value in (args.seed, args.seed_file, args.ask)) > 1:
        sys.exit("error: use only one of --seed, --seed-file or --ask")
    if args.seed_file:
        args.seed = Path(args.seed_file).read_text(encoding="utf-8").strip()
    if args.ask:
        raw = getpass.getpass("entropy seed phrase (any long random text): ").encode("utf-8")
        from keyrescue.crypto.hashes import sha256

        seed = sha256(raw)
    elif args.seed:
        seed = bytes.fromhex(args.seed.strip())
        if len(seed) != ed25519.SEED_SIZE:
            sys.exit(f"error: --seed must be {ed25519.SEED_SIZE * 2} hex characters")
    else:
        seed, _ = ed25519.create_keypair()

    public = ed25519.publickey(seed)
    out_dir = Path(args.out) if args.out else None
    if out_dir is not None:
        _write_private(out_dir / "vendor.seed", seed.hex())
        (out_dir / "vendor.pub").write_text(public.hex() + "\n", encoding="utf-8")
    if args.show_seed:
        print("WARNING: the private seed is being printed to the terminal", file=sys.stderr)
        print(f"\nseed (hex): {seed.hex()}\n", file=sys.stderr)
    _print_snippet(public, out_dir)
    if args.dev:
        print()
        print("as a development key, also set in keys.py:")
        print(f'  DEV_PUBLIC_KEY = "{public.hex()}"')
        print("and run the tests / CLI with KEYRESCUE_ALLOW_DEV_KEYS=1")
    return 0


def cmd_license(args) -> int:
    seed = _read_seed(args)
    issued = args.issued or date.today().isoformat()
    claims: dict[str, object] = {
        "id": args.id or f"{args.tier}-{issued}",
        "tier": args.tier,
    }
    if args.name:
        claims["name"] = args.name
    if args.exp is not None:
        claims["exp"] = args.exp or (date.today() + timedelta(days=args.valid_days)).isoformat()
    if args.seats != 1:
        claims["seats"] = args.seats
    claims["issued"] = issued

    key = encode_license(seed, claims)
    print(key)
    print()
    print(f"tier {args.tier} for {claims.get('name') or claims['id']}, "
          f"expires {claims.get('exp', 'never')}", file=sys.stderr)
    if args.out:
        path = Path(args.out)
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(key + "\n", encoding="utf-8")
        print(f"written to {path}", file=sys.stderr)
    if args.dev:
        print()
        print("development key: the customer build ignores this unless",
              "KEYRESCUE_ALLOW_DEV_KEYS=1", file=sys.stderr)
    return 0


def cmd_check(args) -> int:
    """Verify a license key against a public key without running the product."""
    from keyrescue.licensing.license import decode_license

    text = Path(args.key_file).read_text(encoding="utf-8") if args.key_file else args.key
    if not text:
        sys.exit("error: pass a license key or --key-file")
    public = bytes.fromhex(args.public_key)
    try:
        payload, signature = decode_license(text.strip())
    except Exception as exc:                      # malformed key is an answer, not a crash
        sys.exit(f"error: {exc}")
    ok = ed25519.verify(signature, payload, public)
    print("signature is valid" if ok else "SIGNATURE DOES NOT VERIFY")
    if ok:
        import json

        print(json.dumps(json.loads(payload.decode("utf-8")), indent=2))
    return 0 if ok else 1


# ------------------------------------------------------------------------- main
def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    sub = parser.add_subparsers(dest="command", required=True)

    pair = sub.add_parser("pair", help="create a vendor key pair")
    pair.add_argument("--out", metavar="DIR", help="write vendor.seed/vendor.pub into DIR")
    pair.add_argument("--seed", metavar="HEX", help="use this 32 byte seed instead of random (for tests)")
    pair.add_argument("--seed-file", metavar="PATH",
                      help="re-derive the public key from a saved vendor.seed file")
    pair.add_argument("--ask", action="store_true", help="derive the seed from a typed passphrase")
    pair.add_argument("--show-seed", action="store_true", help="also print the seed (dangerous)")
    pair.add_argument("--dev", action="store_true", help="print the keys.py lines for a development key")
    pair.set_defaults(func=cmd_pair)

    lic = sub.add_parser("license", help="mint a license key")
    lic.add_argument("--seed-file", metavar="PATH", help="file holding the vendor seed as hex")
    lic.add_argument("--seed", metavar="HEX", help="the vendor seed as hex")
    lic.add_argument("--tier", choices=TIERS, default="pro")
    lic.add_argument("--name", default="", help="licensed customer name")
    lic.add_argument("--id", default="", help="license identifier (order id)")
    lic.add_argument("--exp", metavar="ISO-DATE", nargs="?", const="", default=None,
                     help="expiry date; bare --exp means --valid-days from today")
    lic.add_argument("--valid-days", type=int, default=365)
    lic.add_argument("--issued", metavar="ISO-DATE", default=None)
    lic.add_argument("--seats", type=int, default=1)
    lic.add_argument("--out", metavar="PATH", help="also write the key to a file")
    lic.add_argument("--dev", action="store_true", help="note that this only works with dev keys enabled")
    lic.set_defaults(func=cmd_license)

    check = sub.add_parser("check", help="verify a license key against a public key")
    check.add_argument("key", nargs="?", default="")
    check.add_argument("--key-file", metavar="PATH")
    check.add_argument("--public-key", required=True, metavar="HEX")
    check.set_defaults(func=cmd_check)

    return parser


def main(argv: list[str] | None = None) -> int:
    args = build_parser().parse_args(argv)
    return args.func(args)


if __name__ == "__main__":
    sys.exit(main())
