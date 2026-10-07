"""Measure this machine's recovery throughput, one mode at a time.

The numbers are per-process (add ``--threads`` for the parallel speedup) and
are meant to calibrate expectations: a search of a few million candidates in
the ``hex`` mode is minutes of work, while the same keyspace in ``bip38`` or
``wallet`` mode is years.  ``keyrescue benchmark`` prints a table of modes with
the measured rate.
"""

from __future__ import annotations

import time
from dataclasses import dataclass

from .crypto.addresses import p2pkh
from .crypto.bip39 import entropy_to_mnemonic, mnemonic_to_seed
from .crypto.core_wallet import MasterKeyRecord, check_password, derive_key_iv
from .crypto.hashes import sha256
from .crypto.minikey import privkey_from_minikey
from .crypto.secp256k1 import pubkey_from_privkey
from .crypto.wif import encode_wif
from .search.runner import RunConfig, run_engine
from .search.space import SearchSpace, Slot

__all__ = ["benchmark_all", "BenchmarkResult", "make_test_minikey"]


@dataclass
class BenchmarkResult:
    mode: str
    candidates: int
    seconds: float

    @property
    def rate(self) -> float:
        return self.candidates / self.seconds if self.seconds else 0.0


def make_test_minikey(prefix: str = "SzavMBLoXU6kDrqtUVmf") -> str:
    """Find a valid mini private key with the given prefix (brute force the tail)."""
    alphabet = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz"
    tail_len = 30 - len(prefix)
    for candidate_index in range(len(alphabet) ** tail_len):
        value = candidate_index
        tail = []
        for _ in range(tail_len):
            tail.append(alphabet[value % len(alphabet)])
            value //= len(alphabet)
        candidate = prefix + "".join(tail)
        if sha256(f"{candidate}?".encode())[0] == 0:
            return candidate
    raise RuntimeError("no valid mini key found (impossible)")


def _timeit(function, count: int) -> tuple[float, int]:
    start = time.perf_counter()
    done = 0
    for index in range(count):
        function(index)
        done += 1
    return time.perf_counter() - start, done


def _target_address_for(key_index: int) -> str:
    return p2pkh(pubkey_from_privkey(key_index + 1, True))


def _bench_hex(count: int = 4096) -> BenchmarkResult:
    privkey = 0x0C28FCA386C7A227600B2FE50B7CAE11EC86D3BF1FBE471BE89827E19D72AA1D
    address = p2pkh(pubkey_from_privkey(privkey, False))
    from .compare import Target

    target = Target.from_address(address)

    def check(_index: int) -> None:
        key = 0x0C28FCA386C7A227600B2FE50B7CAE11EC86D3BF1FBE471BE89827E19D72AA1C
        target.match_privkey(key)

    seconds, done = _timeit(check, count)
    return BenchmarkResult("hex (address match)", done, seconds)


def _bench_base58(count: int = 8192) -> BenchmarkResult:
    from .crypto.base58 import b58check_decode

    wif = encode_wif(bytes.fromhex("0c28fca386c7a227600b2fe50b7cae11ec86d3bf1fbe471be89827e19d72aa1d"), True)

    def check(index: int) -> None:
        candidate = wif[:20] + format(index % 16, "x") + wif[21:]
        try:
            b58check_decode(candidate)
        except Exception:
            pass

    seconds, done = _timeit(check, count)
    return BenchmarkResult("base58 (checksum filter)", done, seconds)


def _bench_minikey(count: int = 2048) -> BenchmarkResult:
    minikey = make_test_minikey()
    address = p2pkh(pubkey_from_privkey(privkey_from_minikey(minikey), False))
    from .compare import Target

    target = Target.from_address(address)
    alphabet = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz"

    def check(index: int) -> None:
        candidate = minikey[:-1] + alphabet[index % len(alphabet)]
        if sha256(f"{candidate}?".encode())[0] != 0:
            return
        target.match_privkey(privkey_from_minikey(candidate))

    seconds, done = _timeit(check, count)
    return BenchmarkResult("minikey (marker + address)", done, seconds)


def _bench_mnemonic(count: int = 64) -> BenchmarkResult:
    from .crypto.bip32 import derive_path
    from .compare import Target

    mnemonic = entropy_to_mnemonic(bytes(range(16)))
    seed = mnemonic_to_seed(mnemonic)
    privkey, _ = derive_path(seed, "m/44'/0'/0'/0/0")
    target = Target.from_address(p2pkh(pubkey_from_privkey(privkey, True)))

    def check(index: int) -> None:
        seed = mnemonic_to_seed(mnemonic)
        try:
            key, _ = derive_path(seed, "m/44'/0'/0'/0/0")
        except Exception:
            return
        target.match_privkey(key)

    seconds, done = _timeit(check, count)
    return BenchmarkResult("mnemonic (PBKDF2 + path + address)", done, seconds)


def _bench_passphrase(count: int = 32) -> BenchmarkResult:
    from .crypto.hashes import pbkdf2_hmac_sha512

    def check(index: int) -> None:
        pbkdf2_hmac_sha512(b"mnemonic words here", b"mnemonic" + str(index).encode(), 2048, 64)

    seconds, done = _timeit(check, count)
    return BenchmarkResult("passphrase (PBKDF2 only)", done, seconds)


def _bench_bip38(count: int = 4) -> BenchmarkResult:
    from .crypto.bip38 import decrypt_bip38, parse_bip38

    record = parse_bip38("6PRVWUbkzzsbcVac2qwfssoUJAN1Xhrg6bNk8J7Nzm5H7kxEbn2Nh2ZoGg")

    def check(index: int) -> None:
        decrypt_bip38(record, f"wrong{index}")

    seconds, done = _timeit(check, count)
    return BenchmarkResult("bip38 (scrypt N=16384)", done, seconds)


def _bench_wallet(count: int = 4, iterations: int = 1000) -> BenchmarkResult:
    salt = bytes(range(8))
    key, iv = derive_key_iv(b"bench", salt, iterations)
    from .crypto.aes import AES256ECB
    from .crypto.hashes import sha512

    from .crypto.secp256k1 import N

    master = (0x1234567890ABCDEF1234567890ABCDEF1234567890ABCDEF1234567890ABCDEF % (N - 1) + 1).to_bytes(32, "big")
    crypted = AES256ECB(key).cbc_encrypt(master, iv)
    record = MasterKeyRecord(crypted, salt, iterations)

    def check(index: int) -> None:
        check_password(f"wrong{index}".encode(), record)

    seconds, done = _timeit(check, count)
    return BenchmarkResult(f"wallet.dat ({iterations} iterations)", done * iterations, seconds)


def benchmark_all(quick: bool = True) -> list[BenchmarkResult]:
    """Run every benchmark and return the results (sorted by mode)."""
    scale = 1 if quick else 8
    results = []
    for function, count in (
        (_bench_hex, 4096 * scale),
        (_bench_base58, 8192 * scale),
        (_bench_minikey, 2048 * scale),
        (_bench_mnemonic, 64 * scale),
        (_bench_passphrase, 32 * scale),
        (_bench_bip38, 4 * scale),
        (_bench_wallet, 4 * scale),
    ):
        try:
            results.append(function(count))
        except Exception as exc:  # pragma: no cover - a broken backend should not hide the rest
            results.append(BenchmarkResult(f"{function.__name__} (failed: {exc})", 0, 1.0))
    return results


def _space_smoke_test() -> None:  # pragma: no cover - used by tools, not tests
    space = SearchSpace.from_template("aa??", "0123456789abcdef")
    config = RunConfig(threads=1, progress=False, quiet=True)
    from .engines.base16 import Base16Engine  # noqa: F401  (import check)

    del space, config
    run_engine  # noqa: B018
