"""Command line interface for KeyRescue.

Design goals: everything is discoverable from ``--help`` (examples live in the
epilog of every mode), results are readable by a human and parsable by a
script (``--json``), and nothing ever touches the network.
"""

from __future__ import annotations

import argparse
import sys
from pathlib import Path

from . import reporting
from .benchmark import benchmark_all
from .engines import ENGINES
from .errors import (
    EXIT_INTERRUPTED,
    EXIT_LICENSE,
    EXIT_NO_RESULT,
    EXIT_OK,
    EXIT_USAGE,
    InvalidInput,
    KeyRescueError,
    LicenseError,
    UsageError,
)
from .licensing import LicenseStore, PURCHASE_URL, verify_license
from .search.checkpoint import DEFAULT_SESSION_NAME, load_session
from .search.progress import format_duration, format_rate
from .search.runner import RunConfig, default_threads, run_engine
from .version import CODENAME, HOMEPAGE, PRODUCT, __version__

__all__ = ["main", "build_parser"]

BANNER = f"{PRODUCT} {__version__} ({CODENAME})"

RUN_OPTION_DEFAULTS = {
    "threads": 0,
    "session": None,
    "resume": False,
    "progress": True,
    "quiet": False,
    "json": False,
    "report": None,
    "estimate": False,
    "max_candidates": None,
    "stop_on_first": True,
    "i_own_this": False,
    "force": False,
    "license": None,
    "license_file": None,
    "include_secrets": False,
    "chunk_size": 0,
}

OWNERSHIP_NOTICE = """\
This mode attacks encrypted data, so KeyRescue asks you to confirm that the
backup is yours before it starts:

    --i-own-this

Only continue for your own wallet, or for a wallet whose owner gave you
written permission. Cracking somebody else's wallet is theft, and this tool is
not built for it: it never connects to the network and only ever checks
candidates against data you provide.
"""


def add_run_options(parser: argparse.ArgumentParser, top_level: bool = False) -> None:
    """Add the options that apply to every recovery mode.

    On the top level parser the real defaults are set; on sub-parsers the
    defaults are suppressed so an explicitly passed top level value wins over a
    sub-parser default (argparse only fills in an attribute when it is unset).
    """
    def default(name):
        return RUN_OPTION_DEFAULTS[name] if top_level else argparse.SUPPRESS

    group = parser.add_argument_group("search options")
    group.add_argument("--threads", type=int, default=default("threads"),
                       help="worker processes (default: one per CPU)")
    group.add_argument("--chunk-size", type=int, default=default("chunk_size"),
                       help="candidates per work unit (default: tuned per mode)")
    group.add_argument("--max-candidates", type=int, default=default("max_candidates"),
                       help="stop after this many candidates (useful for a quick probe)")
    group.add_argument("--all", dest="stop_on_first", action="store_false",
                       default=default("stop_on_first"),
                       help="keep searching after the first match and report every hit")
    group.add_argument("--session", metavar="PATH", default=default("session"),
                       help="write a resumable session file (Pro)")
    group.add_argument("--resume", action="store_true", default=default("resume"),
                       help="resume the search saved in the session file")
    group.add_argument("--estimate", action="store_true", default=default("estimate"),
                       help="only report the size of the search space and an estimated runtime")
    group.add_argument("--quiet", action="store_true", default=default("quiet"),
                       help="no progress output (results still printed)")
    group.add_argument("--no-progress", dest="progress", action="store_false",
                       default=default("progress"), help="alias for --quiet on the progress bar only")
    group.add_argument("--json", action="store_true", default=default("json"),
                       help="print the result as JSON")
    group.add_argument("--include-secrets", action="store_true", default=default("include_secrets"),
                       help="include recovered private keys/passphrases in JSON reports")
    group.add_argument("--report", metavar="PATH", default=default("report"),
                       help="write a report file (.json for JSON, otherwise text)")

    advanced = parser.add_argument_group("advanced")
    advanced.add_argument("--i-own-this", action="store_true", default=default("i_own_this"),
                          help="confirm that the backup being recovered is yours")
    advanced.add_argument("--force", action="store_true", default=default("force"),
                          help="same as --i-own-this (kept for scripting)")
    advanced.add_argument("--license", metavar="KEY", default=default("license"),
                          help="license key to use for this run")
    advanced.add_argument("--license-file", metavar="PATH", default=default("license_file"),
                          help="read the license key from this file")


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        prog="keyrescue",
        description=f"{BANNER}\n\nOffline recovery of your own Bitcoin keys, mnemonics and passphrases.",
        epilog=(
            "Run 'keyrescue <mode> --help' for mode specific options and examples.\n"
            f"Documentation: {HOMEPAGE}   Support: {PURCHASE_URL}"
        ),
        formatter_class=argparse.RawDescriptionHelpFormatter,
    )
    parser.add_argument("--version", action="version", version=BANNER)
    add_run_options(parser, top_level=True)

    subparsers = parser.add_subparsers(dest="command", metavar="<mode>")

    for slug, engine_class in ENGINES.items():
        sub = subparsers.add_parser(
            slug,
            help=engine_class.title,
            description=f"{engine_class.title}\n\n{engine_class.description}",
            epilog="examples:\n  " + "\n  ".join(engine_class.examples),
            formatter_class=argparse.RawDescriptionHelpFormatter,
        )
        engine_class.add_arguments(sub)
        add_run_options(sub)

    # ------------------------------------------------------------ utilities
    info = subparsers.add_parser("info", help="describe an input and estimate the work")
    info.add_argument("value", nargs="+", help="an address, key, mnemonic or damaged backup string")
    info.add_argument("--language", default="english", help="word list used for mnemonics")

    license_parser = subparsers.add_parser("license", help="activate and inspect license keys")
    license_sub = license_parser.add_subparsers(dest="license_command", metavar="<action>")
    license_sub.add_parser("show", help="show the active license")
    license_verify = license_sub.add_parser("verify", help="verify a license key without activating it")
    license_verify.add_argument("key", help="the license key")
    license_activate = license_sub.add_parser("activate", help="store a license key on this machine")
    license_activate.add_argument("key", help="the license key")
    license_sub.add_parser("remove", help="remove the stored license key")
    license_sub.add_parser("tiers", help="explain what each tier includes")

    benchmark = subparsers.add_parser("benchmark", help="measure this machine's recovery speed")
    benchmark.add_argument("--full", action="store_true", help="run a longer, more accurate benchmark")

    subparsers.add_parser("doctor", help="report backends, CPU count and license state")
    return parser


# --------------------------------------------------------------------------
# utility commands
# --------------------------------------------------------------------------


def _print_license(license_obj, store: LicenseStore) -> None:
    print(BANNER)
    print()
    print(license_obj.describe())
    path = store.path
    print()
    if license_obj.source.startswith("environment"):
        print(f"active license: {license_obj.source}")
    print(f"license file: {path}{'' if path.exists() else ' (not present)'}")
    if license_obj.tier.name == "free":
        print(f"upgrade: {PURCHASE_URL}")


def cmd_license(args) -> int:
    store = LicenseStore(Path(args.license_file) if args.license_file else None)
    action = args.license_command or "show"

    if action == "show":
        _print_license(store.current(), store)
        return EXIT_OK

    if action == "verify":
        license_obj = verify_license(args.key)
        print("license verifies correctly\n")
        print(license_obj.describe())
        return EXIT_OK

    if action == "activate":
        license_obj = verify_license(args.key)
        path = store.save(args.key)
        print(f"license activated: {license_obj.tier.label} for {license_obj.name}")
        print(f"stored in {path}")
        if license_obj.warning:
            print(f"note: {license_obj.warning}")
        return EXIT_OK

    if action == "remove":
        removed = store.remove()
        print("stored license removed" if removed else "there was no stored license")
        return EXIT_OK

    if action == "tiers":
        from .licensing import TIERS

        for tier in TIERS.values():
            print(f"{tier.label} ({tier.name})")
            print(f"  {tier.description}")
            for feature in tier.features:
                print(f"  - {feature}")
            print()
        print(f"Pricing and purchase: {PURCHASE_URL}")
        return EXIT_OK

    raise UsageError(f"unknown license action {action!r}")


def cmd_doctor(args) -> int:
    from .crypto import aes, hashes, secp256k1
    from .crypto.bip39 import available_wordlists
    from .licensing import ALLOW_DEV_KEYS, VENDOR_PUBLIC_KEYS

    store = LicenseStore(Path(args.license_file) if args.license_file else None)
    print(BANNER)
    print()
    from .backends import ENV_VAR, prefer_pure_python

    print("backends")
    print(f"  secp256k1:      {secp256k1.BACKEND}"
          + (" (install 'coincurve' for ~40x more speed)" if secp256k1.BACKEND == "python" else ""))
    print(f"  AES:            {aes.BACKEND}")
    print(f"  RIPEMD-160:     {'accelerated' if hashes.HAS_ACCELERATED_RIPEMD160 else 'pure python (slow)'}")
    print(f"  workers:        {default_threads()} usable CPUs")
    if prefer_pure_python():
        print(f"  override:       {ENV_VAR}=pure (accelerators ignored)")
    print(f"  word lists:     {', '.join(available_wordlists()) or 'none found'}")
    print()
    print("licensing")
    print(f"  vendor keys:    {len(VENDOR_PUBLIC_KEYS) or 'none configured'}")
    print(f"  dev keys:       {'accepted (KEYRESCUE_ALLOW_DEV_KEYS is set)' if ALLOW_DEV_KEYS() else 'rejected'}")
    try:
        license_obj = store.current()
        print(f"  active tier:    {license_obj.tier.label}")
    except LicenseError as exc:
        print(f"  active tier:    invalid stored license ({exc})")
    print()
    print("run 'keyrescue benchmark' to measure recovery speed on this machine")
    return EXIT_OK


def cmd_benchmark(args) -> int:
    print(BANNER)
    print("\nmeasuring (this takes a few seconds)...\n")
    results = benchmark_all(quick=not args.full)
    width = max(len(r.mode) for r in results)
    print(f"{'mode'.ljust(width)}  {'rate':>14}")
    print("-" * (width + 18))
    for result in results:
        print(f"{result.mode.ljust(width)}  {format_rate(result.rate):>14}")
    print()
    print("time for a few common keyspaces at the measured single-core rates:")
    for label, count in (("16^4  = 65,536", 65_536), ("base58^4 = 11.3M", 11_316_496), ("16^8  = 4.3B", 4_294_967_296)):
        line = [f"  {label:<16}"]
        for result in results[:6]:
            seconds = count / result.rate if result.rate else float("inf")
            line.append(f"{result.mode.split(' ')[0]}={format_duration(seconds)}")
        print("  ".join(line))
    print("\nadd --threads N for the parallel speedup on this machine")
    return EXIT_OK


def _estimate_for(count: int, seconds_per_candidate: float) -> str:
    seconds = count * seconds_per_candidate / max(default_threads(), 1)
    return f"{count:,} candidates -> about {format_duration(seconds)} on {default_threads()} core(s)"


def cmd_info(args) -> int:
    from .compare import Target
    from .crypto.addresses import all_addresses
    from .crypto.base58 import b58check_decode, has_invalid_chars
    from .crypto.bip38 import parse_bip38
    from .crypto.bip39 import electrum_seed_type, load_wordlist, validate_bip39
    from .crypto.minikey import minikey_info
    from .crypto.secp256k1 import pubkey_from_privkey
    from .crypto.wif import decode_wif, is_wif

    text = " ".join(args.value).strip()
    print(BANNER)
    print()

    def show_key(key_bytes: bytes, compressed: bool | None = None, note: str = "") -> None:
        key = int.from_bytes(key_bytes, "big")
        if note:
            print(f"  {note}")
        print(f"  {'private key:':<22}{key_bytes.hex()}")
        forms = (True, False) if compressed is None else (compressed,)
        for compressed_flag in forms:
            pub = pubkey_from_privkey(key, compressed_flag)
            label = "compressed" if compressed_flag else "uncompressed"
            print(f"  {label + ' public key:':<22}{pub.hex()}")
        # every address type for this key, in both encodings, listed once
        for name, value in all_addresses(pubkey_from_privkey(key, True)).items():
            print(f"    {name:<20} {value}")
        from .crypto.wif import encode_wif

        print(f"  {'WIF (compressed):':<22}{encode_wif(key_bytes, True)}")
        print(f"  {'WIF (uncompressed):':<22}{encode_wif(key_bytes, False)}")

    # ------------------------------------------------------------------ cases
    if text.lower().startswith(("bc1", "tb1", "bcrt1")) or (text[:1] in "13" and 26 <= len(text) <= 35):
        info = Target.from_address(text).info
        print(f"address: {text}")
        print(f"  type:     {info.kind}")
        print(f"  network:  {info.network}")
        print(f"  payload:  {info.payload.hex()}")
        print("\nThis is all the tool needs as --target for any recovery mode.")
        return EXIT_OK

    if text.startswith("6P"):
        record = parse_bip38(text)
        mode = "EC-multiplied" if record.ec_multiplied else "direct"
        print(f"BIP-38 encrypted private key ({mode})")
        print(f"  compressed:   {record.compressed}")
        print(f"  address hash: {record.address_hash.hex()}")
        if record.has_lot_sequence:
            lot, sequence = record.lot_and_sequence or (0, 0)
            print(f"  lot/sequence: {lot}/{sequence}")
        print("\nrecover the passphrase with: keyrescue bip38 --input <key> ... --i-own-this")
        return EXIT_OK

    if text[:1] == "S" and len(text) in (22, 26, 30):
        try:
            data = minikey_info(text)
        except InvalidInput:
            pass
        else:
            print(f"mini private key ({data['length']} characters, valid marker: {data['valid_marker']})")
            if data["valid_marker"]:
                # a coin carrying a minikey usually prints the start of the address,
                # so show every address form to make a partially readable one checkable
                show_key(bytes.fromhex(data["privkey_hex"]), None)
            else:
                print(f"  {'private key:':<22}{data['privkey_hex']}")
                print(f"  {'WIF (uncompressed):':<22}{data['privkey_wif_uncompressed']}")
                print(f"  {'WIF (compressed):':<22}{data['privkey_wif_compressed']}")
                print("  note: the typo check failed, so this string is not a key that holds funds")
            return EXIT_OK

    if is_wif(text):
        info = decode_wif(text)
        print(f"WIF private key ({'compressed' if info.compressed else 'uncompressed'})")
        show_key(info.privkey, info.compressed)
        return EXIT_OK

    words = text.split()
    if 2 <= len(words) <= 24 and all(w.isalpha() or w in "?*" or "?" in w or "*" in w for w in words):
        wordlist = load_wordlist(args.language)
        missing = sum(1 for w in words if w in ("?", "*"))
        ok, reason = validate_bip39(text, wordlist)
        electrum_type = electrum_seed_type(text) if not missing else None
        print("mnemonic")
        print(f"  words:      {len(words)}")
        print(f"  bip39:      {'valid' if ok else reason}")
        print(f"  electrum:   {electrum_type or 'not an Electrum v2 seed'}")
        if missing:
            print(f"  unknown:    {missing} word(s)")
            print(f"  {_estimate_for(2048 ** missing, 1.4e-3)}")
            print("\nrecover with: keyrescue mnemonic --input <words> --path <path> --target <address>")
        return EXIT_OK

    cleaned = text.replace("?", "").replace(" ", "")
    if cleaned and all(c in "0123456789abcdefABCDEF" for c in cleaned):
        missing = text.count("?")
        if missing == 0 and len(cleaned) == 64:
            print("hexadecimal private key")
            show_key(bytes.fromhex(cleaned))
            return EXIT_OK
        if missing:
            print(f"damaged hexadecimal key ({len(text)} characters, {missing} unknown)")
            print(f"  {_estimate_for(16 ** missing, 6e-6)}")
            print("\nrecover with: keyrescue hex --input <key> --target <address>")
            return EXIT_OK

    if "?" in text:
        bad = has_invalid_chars(text.replace("?", ""))
        if bad is None:
            try:
                b58check_decode(text.replace("?", "1"))
            except Exception:
                pass
            missing = text.count("?")
            print(f"damaged Base-58 string ({len(text)} characters, {missing} unknown)")
            print(f"  {_estimate_for(58 ** missing, 8e-6)}")
            print("\nrecover with: keyrescue base58 --input <string> --target <address>")
            return EXIT_OK

    raise InvalidInput(
        "could not recognise that input. Supported: addresses, WIF keys, hex private keys, "
        "mini private keys, BIP-38 keys, mnemonics and damaged strings containing '?'."
    )


# --------------------------------------------------------------------------
# recovery runs
# --------------------------------------------------------------------------


def _resolve_license(args):
    store = LicenseStore(Path(args.license_file) if args.license_file else None)
    if args.license:
        return verify_license(args.license)
    return store.current()


def _enforce_tier(license_obj, args, engine, total: int, config: RunConfig) -> list[str]:
    """Apply tier limits, returning human readable notices."""
    tier = license_obj.tier
    notices: list[str] = []

    if not tier.permits_candidates(total):
        raise LicenseError(
            f"this search space holds {total:,} candidates, which is above the "
            f"{tier.label} limit of {tier.max_candidates:,} candidates.\n"
            f"Options: upgrade at {PURCHASE_URL}, activate a license with --license, "
            f"or probe a subset with --max-candidates {tier.max_candidates:,}."
        )

    requested_threads = config.threads if config.threads > 0 else default_threads()
    if tier.max_threads is not None and requested_threads > tier.max_threads:
        # clamp quietly when "one per CPU" was only the default; a licence should
        # not nag about --threads the user never typed
        if config.threads > tier.max_threads:
            notices.append(
                f"{tier.label} licenses use {tier.max_threads} core(s); "
                f"ignoring --threads {requested_threads} (upgrade at {PURCHASE_URL})"
            )
        config.threads = tier.max_threads

    if (args.session or args.resume) and not tier.allow_sessions:
        raise LicenseError(
            f"resumable sessions are a {license_obj.tier.label} feature.\n"
            f"Upgrade at {PURCHASE_URL} or run without --session/--resume."
        )
    return notices


def cmd_run(args) -> int:
    engine_class = ENGINES[args.command]
    config = RunConfig(
        threads=args.threads,
        chunk_size=args.chunk_size,
        max_candidates=args.max_candidates,
        progress=args.progress,
        quiet=args.quiet,
        stop_on_first=args.stop_on_first,
        session_path=args.session,
        checkpoint_interval=5.0,
    )

    engine = engine_class.from_args(args, config)
    engine.ensure_prepared()  # validates input, builds the space and the target

    if engine.preflight():  # e.g. --list-mkeys: the answer was printed, no search needed
        return EXIT_OK

    license_obj = _resolve_license(args)
    total = engine.space.total

    header_lines = [BANNER, "", engine.describe(), ""]
    if license_obj.tier.name != "free":
        header_lines.append(f"licensed to {license_obj.name} ({license_obj.tier.label})")
    if engine.requires_ownership_ack and not (args.i_own_this or args.force):
        print("\n".join(header_lines))
        print(OWNERSHIP_NOTICE)
        return EXIT_USAGE

    if license_obj.warning:
        print(f"note: {license_obj.warning}", file=sys.stderr)

    if args.estimate:
        # Estimating costs nothing, so it is deliberately reported even when the
        # space is over the licence limit: that is how a user decides whether to
        # narrow the search or upgrade.
        print("\n".join(header_lines))
        print(f"total candidates: {total:,}")
        threads = config.threads if config.threads > 0 else default_threads()
        seconds = total * engine.cost_per_candidate / max(threads, 1)
        print(f"estimated time:   {format_duration(seconds)} on {threads} core(s)")
        if total > 10_000_000 and engine.cost_per_candidate > 1e-4:
            print("note: this space is very large for this mode; narrow it with --length/--charset/--max-candidates")
        if not license_obj.tier.permits_candidates(total):
            print(
                f"note: running this search needs more than the {license_obj.tier.label} limit of "
                f"{license_obj.tier.max_candidates:,} candidates -- upgrade at {PURCHASE_URL} "
                f"or probe part of it with --max-candidates {license_obj.tier.max_candidates:,}",
                file=sys.stderr,
            )
        return EXIT_OK

    notices = _enforce_tier(license_obj, args, engine, total, config)
    for notice in notices:
        print(f"note: {notice}", file=sys.stderr)

    # --------------------------------------------------------------- session
    session_path = args.session or (DEFAULT_SESSION_NAME if args.resume else None)
    if args.resume:
        if not session_path or not Path(session_path).exists():
            raise UsageError(f"no session file to resume at {session_path}")
        session = load_session(session_path)
        if not session.matches(engine.slug, engine.space.signature()):
            raise UsageError(
                f"the session file {session_path} does not match this search "
                f"(saved mode: {session.engine}, current: {engine.slug}). "
                "Pass --session <other file> or start a fresh run."
            )
        config.session = session
        config.start_index = session.next_index
        if session.next_index >= total:
            print("\n".join(header_lines))
            print(f"session is already complete ({total:,} candidates checked)")
            return EXIT_NO_RESULT
        header_lines.append(f"resuming from candidate {session.next_index:,} of {total:,}")
    config.session_path = session_path

    if not args.quiet and not args.json:
        print("\n".join(header_lines))

    report = run_engine(engine, config)

    if args.json:
        print(reporting.render_json(report, engine, args.include_secrets, extra={"license": license_obj.tier.name}))
    else:
        print(reporting.render_text(report, engine))
        if report.found:
            print(f"\nsave this output somewhere safe. {PRODUCT} never sends it anywhere.")

    if args.report:
        path = reporting.write_report(args.report, report, engine, include_secrets=args.include_secrets)
        if not args.quiet:
            print(f"report written to {path}")

    if report.aborted and not report.found:
        return EXIT_INTERRUPTED
    return EXIT_OK if report.found else EXIT_NO_RESULT


# --------------------------------------------------------------------------


def main(argv: list[str] | None = None) -> int:
    """Entry point. Always returns an exit code (never raises SystemExit itself;
    argparse's own usage errors are converted back into a code so that callers
    embedding KeyRescue get a predictable return value)."""
    parser = build_parser()
    try:
        args = parser.parse_args(argv)
    except SystemExit as exc:  # argparse already printed usage/help
        return int(exc.code) if isinstance(exc.code, int) else EXIT_USAGE

    if not getattr(args, "command", None):
        parser.print_help()
        return EXIT_USAGE

    try:
        if args.command == "license":
            return cmd_license(args)
        if args.command == "doctor":
            return cmd_doctor(args)
        if args.command == "benchmark":
            return cmd_benchmark(args)
        if args.command == "info":
            return cmd_info(args)
        return cmd_run(args)
    except LicenseError as exc:
        print(f"license error: {exc}", file=sys.stderr)
        return EXIT_LICENSE
    except (UsageError, InvalidInput) as exc:
        print(f"error: {exc}", file=sys.stderr)
        return EXIT_USAGE
    except KeyRescueError as exc:
        print(f"error: {exc}", file=sys.stderr)
        return EXIT_USAGE
    except KeyboardInterrupt:  # pragma: no cover - interactive
        print("\ninterrupted", file=sys.stderr)
        return EXIT_INTERRUPTED


if __name__ == "__main__":  # pragma: no cover
    sys.exit(main())
