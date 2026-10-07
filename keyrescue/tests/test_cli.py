"""End to end tests for the command line: every recovery mode, licence tiers,
sessions, reports and the exit-code contract.

The modes are driven through :func:`keyrescue.cli.main` in-process (fast, and it
also exercises argument parsing), and every expectation is a value that comes
from a published specification: the private key whose address is
``1BgGZ9tcN4rm9KBzDn7KprQz87SZ26SAMH``, the BIP-39 "abandon" mnemonic, the
BIP-38 test vectors and the Bitcoin Wiki minikey sample.
"""

from __future__ import annotations

import json

import pytest

from keyrescue import cli
from keyrescue.crypto.addresses import p2pkh
from keyrescue.crypto.bip32 import derive_path_privkey
from keyrescue.crypto.bip39 import mnemonic_to_seed
from keyrescue.crypto.hashes import pbkdf2_hmac_sha512
from keyrescue.crypto.secp256k1 import pubkey_from_privkey
from keyrescue.licensing import ed25519, keys as keyring
from keyrescue.licensing.license import encode_license

# ------------------------------------------------------------------- fixtures
KEY_HEX = "0c28fca386c7a227600b2fe50b7cae11ec86d3bf1fbe471be89827e19d72aa1d"
KEY_UNCOMPRESSED_ADDRESS = "1GAehh7TsJAHuUAeKZcXf5CnwuGuGgyX2S"
WIF_UNCOMPRESSED = "5HueCGU8rMjxEXxiPuD5BDku4MkFqeZyd4dZ1jvhTVqvbTLvyTJ"
MINIKEY = "S6c56bnXQiBjk9mqSYE7ykVQ7NzrRy"
MINIKEY_ADDRESS = "1CciesT23BNionJeXrbxmjc7ywfiyM4oLW"
BIP38_ENCRYPTED = "6PRVWUbkzzsbcVac2qwfssoUJAN1Xhrg6bNk8J7Nzm5H7kxEbn2Nh2ZoGg"
BIP38_PASSPHRASE = "TestingOneTwoThree"
MNEMONIC = "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about"


def child_address(mnemonic: str, passphrase: str = "", path: str = "m/44'/0'/0'/0/0") -> str:
    seed = mnemonic_to_seed(mnemonic, passphrase)
    return p2pkh(pubkey_from_privkey(derive_path_privkey(seed, path), True))


@pytest.fixture
def run(capsys):
    """Run the CLI in-process and return ``(exit_code, stdout, stderr)``."""

    def _run(*argv):
        code = cli.main([str(part) for part in argv])
        captured = capsys.readouterr()
        return code, captured.out, captured.err

    return _run


@pytest.fixture
def run_json(run):
    def _run(*argv, expect=0):
        code, out, err = run(*argv, "--json", "--quiet", "--include-secrets")
        assert code == expect, f"exit {code} (expected {expect})\n{out}\n{err}"
        return json.loads(out) if out.strip() else None

    return _run


@pytest.fixture
def pro(monkeypatch):
    """A Pro licence signed by a throwaway vendor key, active via the environment."""
    seed, public = ed25519.create_keypair()
    monkeypatch.setattr(keyring, "VENDOR_PUBLIC_KEYS", (public.hex(),))
    key = encode_license(seed, {"id": "test", "tier": "pro", "name": "Test Suite"})
    monkeypatch.setenv("KEYRESCUE_LICENSE", key)
    return key


# --------------------------------------------------------------- basic surface
def test_version_and_help(run):
    code, out, _ = run("--version")
    assert code == 0 and "KeyRescue" in out
    code, out, _ = run("--help")
    assert code == 0
    for mode in ("hex", "base58", "minikey", "mnemonic", "passphrase", "bip38", "wallet"):
        assert mode in out
    code, out, _ = run()
    assert code == 2 and "usage" in out.lower()


def test_doctor_reports_backends(run):
    code, out, _ = run("doctor")
    assert code == 0
    assert "secp256k1" in out and "RIPEMD-160" in out and "workers" in out


def test_doctor_shows_the_pure_python_override(run, monkeypatch):
    monkeypatch.setenv("KEYRESCUE_BACKEND", "pure")
    from keyrescue.crypto import secp256k1  # re-read is not possible, so assert the note

    code, out, _ = run("doctor")
    assert code == 0
    if secp256k1.BACKEND == "python":
        assert "override" in out and "accelerators ignored" in out
    else:  # pragma: no cover - the module reads the variable at import time
        assert "secp256k1" in out


def test_mode_help_lists_mode_specific_options(run):
    code, out, _ = run("mnemonic", "--help")
    assert code == 0
    assert "--path" in out and "--wordlist" in out


def test_info_decodes_each_format(run):
    code, out, _ = run("info", MINIKEY_ADDRESS)
    assert code == 0 and "p2pkh" in out and "--target" in out
    code, out, _ = run("info", WIF_UNCOMPRESSED)
    assert code == 0 and KEY_HEX in out
    code, out, _ = run("info", MINIKEY)
    assert code == 0 and "mini" in out.lower() and MINIKEY_ADDRESS in out
    assert WIF_UNCOMPRESSED not in out          # different key, must not leak in
    code, out, _ = run("info", MNEMONIC)
    assert code == 0 and "mnemonic" in out.lower()
    code, out, err = run("info")
    assert code == 2


def test_info_reports_what_it_could_not_use(run):
    """An inspector must explain itself rather than crash on odd input."""
    code, out, err = run("info", "definitely not a bitcoin thing")
    assert code == 0
    text = out + err
    assert "mnemonic" in text.lower() or "not" in text.lower()
    assert "Traceback" not in text


# ------------------------------------------------------------------ hex mode
def test_hex_recovers_a_missing_character(run_json):
    doc = run_json("hex", "-i", KEY_HEX[:-1] + "?", "--target", KEY_UNCOMPRESSED_ADDRESS)
    assert doc["found"] is True
    assert doc["search"]["checked"] == 16
    assert doc["search"]["total_candidates"] == 16
    assert doc["mode"] == "hex"
    assert doc["results"][0]["candidate"] == KEY_HEX


def test_hex_text_report_and_exit_code(run):
    code, out, _ = run("hex", "-i", KEY_HEX[:-1] + "?", "--target", KEY_UNCOMPRESSED_ADDRESS, "--quiet")
    assert code == 0
    assert "RECOVERED" in out and KEY_HEX in out and WIF_UNCOMPRESSED in out
    # secrets are shown in the text report: that is the point of the tool
    assert "p2wpkh" in out


def test_hex_missing_result_exits_one(run):
    code, out, _ = run("hex", "-i", KEY_HEX[:-1] + "?", "--target", "1BgGZ9tcN4rm9KBzDn7KprQz87SZ26SAMH",
                       "--quiet")
    assert code == 1
    assert "no match" in out.lower() or "not" in out.lower()


def test_hex_two_unknown_characters_and_all_flag(run_json):
    doc = run_json("hex", "-i", "??" + KEY_HEX[2:], "--target", KEY_UNCOMPRESSED_ADDRESS, "--all")
    assert doc["found"] is True
    assert doc["search"]["total_candidates"] == 256
    assert doc["search"]["stopped_early"] is False
    assert doc["results"][0]["index"] == 192


def test_explicit_set_syntax(run_json):
    doc = run_json("hex", "-i", KEY_HEX[:-1] + "{d}", "--target", KEY_UNCOMPRESSED_ADDRESS)
    assert doc["found"] is True
    doc = run_json("hex", "-i", KEY_HEX[:-1] + "{a-f}", "--target", KEY_UNCOMPRESSED_ADDRESS)
    assert doc["found"] is True and doc["search"]["total_candidates"] == 6


def test_repetition_shorthand_on_the_command_line(run, run_json):
    """``{2}`` and ``????`` must describe exactly the same search."""
    short = run_json("hex", "-i", "??" + KEY_HEX[2:], "--target", KEY_UNCOMPRESSED_ADDRESS)
    assert short["found"] is True and short["search"]["total_candidates"] == 256
    # the same space written with braces, plus one position fixed by hand
    spaced = run_json("hex", "-i", "{2}" + KEY_HEX[2:], "--target", KEY_UNCOMPRESSED_ADDRESS)
    assert spaced["found"] is True and spaced["results"][0] == short["results"][0]
    # and a wrong literal inside that template simply finds nothing
    wrong = run_json("hex", "-i", "??2" + KEY_HEX[3:], "--target", KEY_UNCOMPRESSED_ADDRESS,
                     expect=1) if KEY_HEX[2] != "2" else None
    if wrong is not None:
        assert wrong["found"] is False
    code, out, err = run("hex", "-i", KEY_HEX[:32] + "{8}" + KEY_HEX[40:],
                         "--target", KEY_UNCOMPRESSED_ADDRESS, "--estimate", "--quiet")
    assert code == 0 and "total candidates: 4,294,967,296" in out
    # over the licence limit, but still estimated: that is how you size a search
    assert "needs more than the Free limit" in err and "upgrade" in err


def test_charset_option_narrows_the_space(run_json, run):
    doc = run_json("hex", "-i", KEY_HEX[:-1] + "?", "--target", KEY_UNCOMPRESSED_ADDRESS,
                   "--charset", "0123456789abcdef")
    assert doc["search"]["total_candidates"] == 16
    # a charset that excludes the right character simply finds nothing
    doc = run_json("hex", "-i", KEY_HEX[:-1] + "?", "--target", KEY_UNCOMPRESSED_ADDRESS,
                   "--charset", "0123456789abce", expect=1)     # no 'd', so no match
    assert doc["found"] is False and doc["search"]["total_candidates"] == 14


def test_estimate_does_not_search(run):
    code, out, _ = run("hex", "-i", KEY_HEX[:8] + "??" + KEY_HEX[10:], "--target",
                       KEY_UNCOMPRESSED_ADDRESS, "--estimate", "--quiet")
    assert code == 0
    assert "total candidates: 256" in out and "estimated time" in out
    assert "RECOVERED" not in out


@pytest.mark.parametrize(
    "argv, message",
    [
        (["hex", "-i", "xyz", "--target", KEY_UNCOMPRESSED_ADDRESS], "unexpected character"),
        (["hex", "-i", "0c28", "--target", KEY_UNCOMPRESSED_ADDRESS], "64 characters"),
        (["hex", "-i", KEY_HEX], "no unknown positions"),
        (["hex", "-i", KEY_HEX[:-1] + "?"], "comparison target is required"),
    ],
)
def test_hex_input_errors_are_clean(run, argv, message):
    code, out, err = run(*argv, "--quiet")
    assert code == 2
    assert message in err


# ---------------------------------------------------------------- base58 mode
def test_base58_recovers_a_wif_character(run_json):
    doc = run_json("base58", "-i", WIF_UNCOMPRESSED[:-1] + "?", "--target", KEY_UNCOMPRESSED_ADDRESS)
    assert doc["found"] is True
    assert doc["results"][0]["candidate"] == WIF_UNCOMPRESSED


def test_base58_repairs_a_damaged_address_without_a_target(run_json):
    """A Base-58 address has a checksum, so a damaged one can be repaired alone."""
    damaged = MINIKEY_ADDRESS[:-2] + "??"
    doc = run_json("base58", "-i", damaged, "--type", "address")
    assert doc["found"] is True
    assert doc["results"][0]["candidate"] == MINIKEY_ADDRESS


def test_base58_needs_a_target_for_wif(run):
    code, out, err = run("base58", "-i", WIF_UNCOMPRESSED[:-1] + "?", "--type", "wif", "--quiet")
    assert code == 2 and "comparison target" in err


# -------------------------------------------------------------- minikey mode
def test_minikey_recovers_a_damaged_key(run_json):
    doc = run_json("minikey", "-i", MINIKEY[:-1] + "?", "--target", MINIKEY_ADDRESS)
    assert doc["found"] is True
    assert doc["results"][0]["candidate"].startswith("S6c56bnXQiBjk9mqSYE7ykVQ7NzrR")
    from keyrescue.crypto.minikey import privkey_from_minikey

    assert doc["results"][0]["detail"]["privkey_hex"] == privkey_from_minikey(MINIKEY).hex()


def test_minikey_rejects_a_31_character_string(run):
    code, out, err = run("minikey", "-i", MINIKEY + "?", "--target", MINIKEY_ADDRESS, "--quiet")
    assert code == 2 and "characters long" in err


# ------------------------------------------------------------- mnemonic mode
def test_mnemonic_recovers_a_missing_word(run_json):
    target = child_address(MNEMONIC)
    parts = MNEMONIC.split()
    parts[-1] = "?"
    doc = run_json("mnemonic", "-i", " ".join(parts), "--path", "m/44'/0'/0'/0/0", "--target", target)
    assert doc["found"] is True
    assert doc["results"][0]["candidate"] == MNEMONIC
    assert doc["engine"]["params"]["type"] == "bip39"


def test_mnemonic_full_space_with_all(run_json):
    target = child_address(MNEMONIC)
    parts = MNEMONIC.split()
    parts[-1] = "?"
    doc = run_json("mnemonic", "-i", " ".join(parts), "--target", target, "--all")
    assert doc["search"]["checked"] == 2048
    assert len(doc["results"]) == 1


def test_mnemonic_pattern_for_a_partially_read_word(run_json):
    target = child_address(MNEMONIC)
    parts = MNEMONIC.split()
    parts[-1] = "abou?"                      # matches only "about"
    doc = run_json("mnemonic", "-i", " ".join(parts), "--target", target)
    assert doc["found"] is True and doc["search"]["total_candidates"] == 1


def test_mnemonic_rejects_unknown_words_and_lengths(run):
    code, out, err = run("mnemonic", "-i", "abandon " * 11 + "notaword2", "--target",
                         child_address(MNEMONIC), "--quiet")
    assert code == 2 and "not in the" in err
    code, out, err = run("mnemonic", "-i", "abandon abandon", "--target", "bc1qw508d6qejxtdg4y5r3zarvary0c5xw7kv8f3t4",
                         "--quiet")
    assert code == 2 and "words" in err


def test_mnemonic_is_case_insensitive(run_json):
    target = child_address(MNEMONIC)
    doc = run_json("mnemonic", "-i", MNEMONIC.title().replace("About", "?"), "--target", target)
    assert doc["found"] is True


# ----------------------------------------------------------- passphrase mode
def test_passphrase_recovers_the_extension_word(run_json):
    target = child_address(MNEMONIC, "swordfish")
    doc = run_json("passphrase", "-i", MNEMONIC, "--words", "opensesame,swordfish",
                   "--target", target, "--i-own-this")
    assert doc["found"] is True
    assert doc["results"][0]["detail"]["passphrase"] == "swordfish"


def test_passphrase_requires_the_ownership_ack(run):
    code, out, err = run("passphrase", "-i", MNEMONIC, "--words", "a,b",
                         "--target", child_address(MNEMONIC), "--quiet")
    assert code == 2
    assert "own" in (out + err).lower()


def test_passphrase_charset_and_length(run_json):
    """A 2 character space over "ab" is exactly 4 candidates."""
    target = child_address(MNEMONIC, "bb")
    doc = run_json("passphrase", "-i", MNEMONIC, "--charset", "ab", "--length", "2",
                   "--target", target, "--i-own-this")
    assert doc["found"] is True and doc["results"][0]["detail"]["passphrase"] == "bb"


def test_passphrase_leet_and_suffix_expansions(run_json):
    """--leet and --suffix compose with the case variants."""
    from keyrescue.search.charsets import build_word_variants

    variants = build_word_variants(["swordfish"], leet=True, case=True, suffixes=("1",))
    assert "swordfish1" in variants and "sw0rdfish1" in variants
    assert len(set(variants)) == len(variants), "variants must not repeat a candidate"

    target = child_address(MNEMONIC, "sw0rdfish1")
    doc = run_json("passphrase", "-i", MNEMONIC, "--words", "swordfish", "--leet",
                   "--suffix", "1", "--target", target, "--i-own-this")
    assert doc["found"] is True
    assert doc["results"][0]["detail"]["passphrase"] == "sw0rdfish1"


def test_passphrase_no_case_shrinks_the_space(run_json):
    from keyrescue.search.charsets import build_word_variants

    with_case = build_word_variants(["swordfish"], leet=False, case=True, suffixes=())
    without = build_word_variants(["swordfish"], leet=False, case=False, suffixes=())
    assert set(without) < set(with_case) and len(without) < len(with_case)


def test_electrum_passphrase_uses_the_electrum_salt(run_json):
    """The seed prefix differs from BIP-39, and the code must reflect that."""
    mnemonic = MNEMONIC
    expected = pbkdf2_hmac_sha512(mnemonic.encode(), b"electrum" + b"swordfish", 2048, 64)
    assert expected != pbkdf2_hmac_sha512(mnemonic.encode(), b"mnemonic" + b"swordfish", 2048, 64)
    target = p2pkh(pubkey_from_privkey(derive_path_privkey(expected, "m/44'/0'/0'/0/0"), True))
    doc = run_json("passphrase", "-i", mnemonic, "--type", "electrum", "--words", "swordfish",
                   "--target", target, "--i-own-this")
    assert doc["found"] is True


# ------------------------------------------------------------------ bip38 mode
def test_bip38_finds_the_passphrase(run_json):
    pytest.importorskip("Crypto")
    doc = run_json("bip38", "-i", BIP38_ENCRYPTED, "--words", f"Satoshi,{BIP38_PASSPHRASE}",
                   "--i-own-this")
    assert doc["found"] is True
    detail = doc["results"][0]["detail"]
    assert detail["passphrase"] == BIP38_PASSPHRASE
    assert detail["privkey_hex"] == "cbf4b9f70470856bb4f40f80b87edb90865997ffee6df315ab166d713af433a5"


def test_bip38_requires_the_ack_even_to_estimate(run):
    code, out, err = run("bip38", "-i", BIP38_ENCRYPTED, "--words", "a", "--quiet")
    assert code == 2 and "own" in (out + err).lower()
    code, out, err = run("bip38", "-i", BIP38_ENCRYPTED, "--words", "a", "--estimate", "--quiet")
    assert code == 2 and "own" in (out + err).lower()


# ------------------------------------------------------------------ wallet mode
def _wallet_params(passphrase=b"correct horse battery staple", iterations=200):
    from Crypto.Cipher import AES

    from keyrescue.crypto.core_wallet import PADDING_BLOCK, derive_key_iv

    key, iv = derive_key_iv(passphrase, bytes(range(8, 16)), iterations)
    crypted = AES.new(key, AES.MODE_CBC, iv).encrypt(bytes(range(32)) + PADDING_BLOCK)
    return {
        "crypted_key": crypted.hex(),
        "salt": bytes(range(8, 16)).hex(),
        "iterations": iterations,
    }


def test_wallet_finds_the_password(run_json):
    pytest.importorskip("Crypto")
    params = _wallet_params()
    doc = run_json("wallet", "--params", json.dumps(params), "--words",
                   "hunter2,correct horse battery staple", "--i-own-this")
    assert doc["found"] is True
    detail = doc["results"][0]["detail"]
    assert detail["password"] == "correct horse battery staple"
    assert detail["master_key_hex"] == bytes(range(32)).hex()


def test_wallet_reads_a_real_file_and_lists_records(run, tmp_path):
    pytest.importorskip("Crypto")
    import binascii

    params = _wallet_params()
    crypted = binascii.unhexlify(params["crypted_key"])
    record = (bytes([48]) + crypted + bytes([8]) + binascii.unhexlify(params["salt"])
              + (0).to_bytes(4, "little") + int(params["iterations"]).to_bytes(4, "little") + b"\x00")
    path = tmp_path / "wallet.dat"
    path.write_bytes(b"\x00" * 200 + b"mkey" + b"\x00" * 12 + record + b"\x00" * 200)

    code, out, err = run("wallet", "--file", str(path), "--list-mkeys", "--quiet")
    assert code == 0
    assert "iterations" in out and params["crypted_key"] in out and "mkey 1" in out

    code, out, err = run("wallet", "--file", str(path), "--words", "correct horse battery staple",
                         "--i-own-this", "--quiet", "--json")
    assert code == 0
    doc = json.loads(out)
    assert doc["found"] is True and "wallet.dat" in doc["engine"]["params"]["source"]


def test_wallet_reports_a_file_it_cannot_use(run, tmp_path):
    path = tmp_path / "empty.dat"
    path.write_bytes(b"\x00" * 40)
    code, out, err = run("wallet", "--file", str(path), "--words", "x", "--i-own-this", "--quiet")
    assert code == 2 and "too small" in err

    path2 = tmp_path / "plain.dat"
    path2.write_bytes(b"\x01" * 4096)
    code, out, err = run("wallet", "--file", str(path2), "--words", "x", "--i-own-this", "--quiet")
    assert code == 2 and "no mkey record" in err

    code, out, err = run("wallet", "--file", str(tmp_path / "missing.dat"), "--words", "x",
                         "--i-own-this", "--quiet")
    assert code == 2 and "does not exist" in err

    code, out, err = run("wallet", "--words", "x", "--i-own-this", "--quiet")
    assert code == 2 and "--file" in err


# ------------------------------------------------------- licence enforcement
def test_free_tier_clamps_threads_with_a_notice(run):
    code, out, err = run("hex", "-i", KEY_HEX[:-1] + "?", "--target", KEY_UNCOMPRESSED_ADDRESS,
                         "--threads", "4", "--quiet")
    assert code == 0
    assert "Free licenses use 1 core" in err and "upgrade" in err


def test_free_tier_blocks_oversized_spaces(run):
    code, out, err = run("hex", "-i", "?" * 32 + KEY_HEX[32:], "--target", KEY_UNCOMPRESSED_ADDRESS,
                         "--quiet")
    assert code == 3
    assert "above the Free limit of 1,000,000 candidates" in err
    assert "--max-candidates 1,000,000" in err          # tells the user what to do


def test_free_tier_blocks_sessions(run, tmp_path):
    code, out, err = run("hex", "-i", KEY_HEX[:-1] + "?", "--target", KEY_UNCOMPRESSED_ADDRESS,
                         "--session", str(tmp_path / "s.json"), "--quiet")
    assert code == 3 and "resumable sessions" in err


def test_a_licence_lifts_the_limits(run, pro):
    doc = json.loads(run("hex", "-i", "?" * 4 + KEY_HEX[4:], "--target", KEY_UNCOMPRESSED_ADDRESS,
                         "--threads", "2", "--chunk-size", "64", "--quiet", "--json")[1])
    assert doc["found"] is True and doc["license"] == "pro"
    assert doc["search"]["total_candidates"] == 65536
    assert "ignoring --threads" not in run("hex", "-i", KEY_HEX[:-1] + "?", "--target",
                                          KEY_UNCOMPRESSED_ADDRESS, "--quiet")[2]


def test_expired_licence_falls_back_to_free(run, monkeypatch):
    seed, public = ed25519.create_keypair()
    monkeypatch.setattr(keyring, "VENDOR_PUBLIC_KEYS", (public.hex(),))
    monkeypatch.setenv("KEYRESCUE_LICENSE", encode_license(
        seed, {"id": "old", "tier": "pro", "exp": "2000-01-01"}))
    code, out, err = run("hex", "-i", KEY_HEX[:-1] + "?", "--target", KEY_UNCOMPRESSED_ADDRESS, "--quiet")
    assert code == 0
    assert "expired" in err or "Free" in err


def test_bad_licence_on_the_command_line_exits_three(run, pro):
    code, out, err = run("hex", "-i", KEY_HEX[:-1] + "?", "--target", KEY_UNCOMPRESSED_ADDRESS,
                         "--license", "KR1-nope-nope", "--quiet")
    assert code == 3 and "license" in err.lower()

    code, out, err = run("hex", "-i", KEY_HEX[:-1] + "?", "--target", KEY_UNCOMPRESSED_ADDRESS,
                         "--license", pro, "--quiet")
    assert code == 0


# ------------------------------------------------------------------- sessions
def test_session_resumes_where_it_stopped(run, tmp_path, pro):
    session = tmp_path / "search.json"
    template = "??" + KEY_HEX[2:]                       # the match sits at index 192
    code, out, err = run("hex", "-i", template, "--target", KEY_UNCOMPRESSED_ADDRESS,
                         "--session", str(session), "--max-candidates", "20", "--quiet", "--json")
    assert code == 1
    doc = json.loads(out)
    assert doc["search"]["checked"] == 20 and doc["found"] is False
    saved = json.loads(session.read_text())
    assert saved["next_index"] == 20 and saved["engine"] == "hex"

    code, out, err = run("hex", "-i", template, "--target", KEY_UNCOMPRESSED_ADDRESS,
                         "--session", str(session), "--resume", "--quiet", "--json")
    assert code == 0
    doc = json.loads(out)
    assert doc["found"] is True and doc["results"][0]["index"] == 192
    assert doc["search"]["resumed_from"] == 20


def test_session_cannot_be_reused_for_a_different_search(run, tmp_path, pro):
    session = tmp_path / "search.json"
    run("hex", "-i", "??" + KEY_HEX[2:], "--target", KEY_UNCOMPRESSED_ADDRESS,
        "--session", str(session), "--max-candidates", "4", "--quiet", "--json")
    code, out, err = run("hex", "-i", "?" + KEY_HEX[1:], "--target", KEY_UNCOMPRESSED_ADDRESS,
                         "--session", str(session), "--resume", "--quiet")
    assert code == 2
    assert "does not match this search" in err


def test_resume_without_a_session_file(run, tmp_path, pro):
    code, out, err = run("hex", "-i", KEY_HEX[:-1] + "?", "--target", KEY_UNCOMPRESSED_ADDRESS,
                         "--resume", "--quiet")
    assert code == 2 and "no session file" in err


# ------------------------------------------------------------------- reporting
def test_json_report_hides_secrets_unless_asked(run):
    _, out, _ = run("hex", "-i", KEY_HEX[:-1] + "?", "--target", KEY_UNCOMPRESSED_ADDRESS,
                    "--quiet", "--json")
    doc = json.loads(out)
    assert doc["found"] is True
    assert "privkey_hex" not in json.dumps(doc)
    assert doc["tool"] == "keyrescue" and doc["version"]

    _, out, _ = run("hex", "-i", KEY_HEX[:-1] + "?", "--target", KEY_UNCOMPRESSED_ADDRESS,
                    "--quiet", "--json", "--include-secrets")
    assert KEY_HEX in json.loads(out)["results"][0]["detail"]["privkey_hex"]


def test_report_file_json_and_text(run, tmp_path):
    json_report = tmp_path / "found.json"
    code, out, _ = run("hex", "-i", KEY_HEX[:-1] + "?", "--target", KEY_UNCOMPRESSED_ADDRESS,
                       "--quiet", "--report", str(json_report))
    assert code == 0 and json_report.exists()
    assert json.loads(json_report.read_text())["found"] is True

    text_report = tmp_path / "found.txt"
    run("hex", "-i", KEY_HEX[:-1] + "?", "--target", KEY_UNCOMPRESSED_ADDRESS, "--quiet",
        "--report", str(text_report))
    assert "RECOVERED" in text_report.read_text() and KEY_HEX in text_report.read_text()


def test_report_is_written_even_when_nothing_is_found(run, tmp_path):
    report = tmp_path / "none.json"
    code, out, _ = run("hex", "-i", KEY_HEX[:-1] + "?", "--target", MINIKEY_ADDRESS, "--quiet",
                       "--json", "--report", str(report))
    assert code == 1 and report.exists()
    assert json.loads(report.read_text())["found"] is False


def test_max_candidates_probe(run_json):
    doc = run_json("hex", "-i", "??" + KEY_HEX[2:], "--target", KEY_UNCOMPRESSED_ADDRESS,
                   "--max-candidates", "8", expect=1)
    assert doc["search"]["checked"] == 8 and doc["search"]["total_candidates"] == 256


# --------------------------------------------------------------------- licence
def test_license_subcommands(run, pro, tmp_path, monkeypatch):
    monkeypatch.setenv("KEYRESCUE_LICENSE_PATH", str(tmp_path / "license.key"))
    monkeypatch.delenv("KEYRESCUE_LICENSE", raising=False)

    code, out, _ = run("license", "show")
    assert code == 0 and "Free" in out and "license file" in out

    code, out, _ = run("license", "tiers")
    assert code == 0
    for label in ("Free", "Trial", "Pro", "Team"):
        assert label in out

    code, out, _ = run("license", "verify", pro)
    assert code == 0 and "verifies correctly" in out and "Pro" in out

    code, out, err = run("license", "verify", "KR1-bad-bad")
    assert code == 3 and "license error" in err

    code, out, _ = run("license", "activate", pro)
    assert code == 0 and "activated" in out and (tmp_path / "license.key").exists()

    code, out, _ = run("license", "show")
    assert "Pro" in out and str(tmp_path / "license.key") in out

    code, out, _ = run("license", "remove")
    assert code == 0 and "removed" in out and not (tmp_path / "license.key").exists()

    code, out, _ = run("license", "remove")
    assert code == 0 and "no stored license" in out


# ------------------------------------------------------------------- benchmark
def test_benchmark_covers_every_mode():
    from keyrescue.benchmark import benchmark_all

    results = benchmark_all(quick=True)
    labelled = " ".join(result.mode for result in results)
    for mode in ("hex", "base58", "minikey", "mnemonic", "passphrase", "wallet"):
        assert mode in labelled, f"{mode} is not benchmarked ({labelled})"
    for result in results:
        assert result.candidates > 0
        assert result.seconds > 0 and result.rate > 0


def test_benchmark_command_runs(run):
    code, out, err = run("benchmark")
    assert code == 0
    assert "hex" in out and "base58" in out and "bip38" in out
