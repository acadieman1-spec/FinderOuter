"""AES-256 used by BIP-38 and by Bitcoin Core wallet.dat files.

Only the operations those formats need are exposed:

* :func:`encrypt_block` / :func:`decrypt_block` -- single 16 byte ECB blocks,
* :func:`cbc_encrypt` / :func:`cbc_decrypt` -- CBC with PKCS#7 padding,
* :class:`AES256ECB` -- a reusable object holding an expanded key schedule.

``pycryptodome`` (or ``cryptography``) is used when installed; otherwise a
compact pure Python implementation is used, which is roughly 30x slower but
only ever runs a handful of blocks per candidate.
"""

from __future__ import annotations

from ..backends import prefer_pure_python
from ..errors import BackendError

__all__ = ["AES256ECB", "encrypt_block", "decrypt_block", "cbc_encrypt", "cbc_decrypt", "BACKEND"]

BACKEND = "python"
try:  # pragma: no cover - depends on the environment
    from Crypto.Cipher import AES as _PCAES  # type: ignore

    BACKEND = "pycryptodome"
except Exception:  # pragma: no cover
    _PCAES = None

if prefer_pure_python():  # see keyrescue.backends
    BACKEND = "python"
    _PCAES = None

# --- pure Python core ------------------------------------------------------

_SBOX = [
    0x63, 0x7C, 0x77, 0x7B, 0xF2, 0x6B, 0x6F, 0xC5, 0x30, 0x01, 0x67, 0x2B, 0xFE, 0xD7, 0xAB, 0x76,
    0xCA, 0x82, 0xC9, 0x7D, 0xFA, 0x59, 0x47, 0xF0, 0xAD, 0xD4, 0xA2, 0xAF, 0x9C, 0xA4, 0x72, 0xC0,
    0xB7, 0xFD, 0x93, 0x26, 0x36, 0x3F, 0xF7, 0xCC, 0x34, 0xA5, 0xE5, 0xF1, 0x71, 0xD8, 0x31, 0x15,
    0x04, 0xC7, 0x23, 0xC3, 0x18, 0x96, 0x05, 0x9A, 0x07, 0x12, 0x80, 0xE2, 0xEB, 0x27, 0xB2, 0x75,
    0x09, 0x83, 0x2C, 0x1A, 0x1B, 0x6E, 0x5A, 0xA0, 0x52, 0x3B, 0xD6, 0xB3, 0x29, 0xE3, 0x2F, 0x84,
    0x53, 0xD1, 0x00, 0xED, 0x20, 0xFC, 0xB1, 0x5B, 0x6A, 0xCB, 0xBE, 0x39, 0x4A, 0x4C, 0x58, 0xCF,
    0xD0, 0xEF, 0xAA, 0xFB, 0x43, 0x4D, 0x33, 0x85, 0x45, 0xF9, 0x02, 0x7F, 0x50, 0x3C, 0x9F, 0xA8,
    0x51, 0xA3, 0x40, 0x8F, 0x92, 0x9D, 0x38, 0xF5, 0xBC, 0xB6, 0xDA, 0x21, 0x10, 0xFF, 0xF3, 0xD2,
    0xCD, 0x0C, 0x13, 0xEC, 0x5F, 0x97, 0x44, 0x17, 0xC4, 0xA7, 0x7E, 0x3D, 0x64, 0x5D, 0x19, 0x73,
    0x60, 0x81, 0x4F, 0xDC, 0x22, 0x2A, 0x90, 0x88, 0x46, 0xEE, 0xB8, 0x14, 0xDE, 0x5E, 0x0B, 0xDB,
    0xE0, 0x32, 0x3A, 0x0A, 0x49, 0x06, 0x24, 0x5C, 0xC2, 0xD3, 0xAC, 0x62, 0x91, 0x95, 0xE4, 0x79,
    0xE7, 0xC8, 0x37, 0x6D, 0x8D, 0xD5, 0x4E, 0xA9, 0x6C, 0x56, 0xF4, 0xEA, 0x65, 0x7A, 0xAE, 0x08,
    0xBA, 0x78, 0x25, 0x2E, 0x1C, 0xA6, 0xB4, 0xC6, 0xE8, 0xDD, 0x74, 0x1F, 0x4B, 0xBD, 0x8B, 0x8A,
    0x70, 0x3E, 0xB5, 0x66, 0x48, 0x03, 0xF6, 0x0E, 0x61, 0x35, 0x57, 0xB9, 0x86, 0xC1, 0x1D, 0x9E,
    0xE1, 0xF8, 0x98, 0x11, 0x69, 0xD9, 0x8E, 0x94, 0x9B, 0x1E, 0x87, 0xE9, 0xCE, 0x55, 0x28, 0xDF,
    0x8C, 0xA1, 0x89, 0x0D, 0xBF, 0xE6, 0x42, 0x68, 0x41, 0x99, 0x2D, 0x0F, 0xB0, 0x54, 0xBB, 0x16,
]
_INV_SBOX = [0] * 256
for _i, _v in enumerate(_SBOX):
    _INV_SBOX[_v] = _i

_RCON = [0x01, 0x02, 0x04, 0x08, 0x10, 0x20, 0x40, 0x80, 0x1B, 0x36, 0x6C, 0xD8, 0xAB, 0x4D]


def _xtime(a: int) -> int:
    a <<= 1
    if a & 0x100:
        a ^= 0x11B
    return a & 0xFF


def _mul(a: int, b: int) -> int:
    result = 0
    while b:
        if b & 1:
            result ^= a
        a = _xtime(a)
        b >>= 1
    return result


def _expand_key(key: bytes, nk: int = 8, nr: int = 14) -> list[list[int]]:
    """AES key schedule -> list of 4-byte word lists (big endian words)."""
    if len(key) != nk * 4:
        raise BackendError(f"AES key must be {nk * 4} bytes, got {len(key)}")
    words = [list(key[4 * i : 4 * i + 4]) for i in range(nk)]
    for i in range(nk, 4 * (nr + 1)):
        temp = list(words[i - 1])
        if i % nk == 0:
            temp = temp[1:] + temp[:1]                      # RotWord
            temp = [_SBOX[b] for b in temp]                  # SubWord
            temp[0] ^= _RCON[i // nk - 1]
        elif nk > 6 and i % nk == 4:
            temp = [_SBOX[b] for b in temp]
        words.append([a ^ b for a, b in zip(words[i - nk], temp)])
    return words


def _add_round_key(state: list[int], words: list[list[int]], rnd: int) -> None:
    for c in range(4):
        word = words[rnd * 4 + c]
        for r in range(4):
            state[4 * c + r] ^= word[r]


def _sub_bytes(state: list[int], box: list[int]) -> None:
    for i in range(16):
        state[i] = box[state[i]]


def _shift_rows(state: list[int]) -> None:
    for r in range(1, 4):
        row = [state[4 * c + r] for c in range(4)]
        row = row[r:] + row[:r]
        for c in range(4):
            state[4 * c + r] = row[c]


def _inv_shift_rows(state: list[int]) -> None:
    for r in range(1, 4):
        row = [state[4 * c + r] for c in range(4)]
        row = row[-r:] + row[:-r]
        for c in range(4):
            state[4 * c + r] = row[c]


def _mix_columns(state: list[int]) -> None:
    for c in range(4):
        a0, a1, a2, a3 = state[4 * c : 4 * c + 4]
        state[4 * c + 0] = _xtime(a0) ^ (_xtime(a1) ^ a1) ^ a2 ^ a3
        state[4 * c + 1] = a0 ^ _xtime(a1) ^ (_xtime(a2) ^ a2) ^ a3
        state[4 * c + 2] = a0 ^ a1 ^ _xtime(a2) ^ (_xtime(a3) ^ a3)
        state[4 * c + 3] = (_xtime(a0) ^ a0) ^ a1 ^ a2 ^ _xtime(a3)


def _inv_mix_columns(state: list[int]) -> None:
    for c in range(4):
        a0, a1, a2, a3 = state[4 * c : 4 * c + 4]
        state[4 * c + 0] = _mul(a0, 14) ^ _mul(a1, 11) ^ _mul(a2, 13) ^ _mul(a3, 9)
        state[4 * c + 1] = _mul(a0, 9) ^ _mul(a1, 14) ^ _mul(a2, 11) ^ _mul(a3, 13)
        state[4 * c + 2] = _mul(a0, 13) ^ _mul(a1, 9) ^ _mul(a2, 14) ^ _mul(a3, 11)
        state[4 * c + 3] = _mul(a0, 11) ^ _mul(a1, 13) ^ _mul(a2, 9) ^ _mul(a3, 14)


class AES256ECB:
    """AES-256 in ECB mode without padding (a reusable key schedule)."""

    __slots__ = ("_words", "_key", "_cipher")

    block_size = 16

    def __init__(self, key: bytes):
        if len(key) != 32:
            raise BackendError("AES-256 requires a 32 byte key")
        self._key = key
        self._cipher = _PCAES.new(key, _PCAES.MODE_ECB) if _PCAES is not None else None
        self._words = [] if self._cipher is not None else _expand_key(key)

    def encrypt_block(self, block: bytes) -> bytes:
        if len(block) != 16:
            raise BackendError("AES block must be 16 bytes")
        if self._cipher is not None:
            return self._cipher.encrypt(block)
        state = list(block)
        _add_round_key(state, self._words, 0)
        for rnd in range(1, 14):
            _sub_bytes(state, _SBOX)
            _shift_rows(state)
            _mix_columns(state)
            _add_round_key(state, self._words, rnd)
        _sub_bytes(state, _SBOX)
        _shift_rows(state)
        _add_round_key(state, self._words, 14)
        return bytes(state)

    def decrypt_block(self, block: bytes) -> bytes:
        if len(block) != 16:
            raise BackendError("AES block must be 16 bytes")
        if self._cipher is not None:
            return self._cipher.decrypt(block)
        state = list(block)
        _add_round_key(state, self._words, 14)
        for rnd in range(13, 0, -1):
            _inv_shift_rows(state)
            _sub_bytes(state, _INV_SBOX)
            _add_round_key(state, self._words, rnd)
            _inv_mix_columns(state)
        _inv_shift_rows(state)
        _sub_bytes(state, _INV_SBOX)
        _add_round_key(state, self._words, 0)
        return bytes(state)

    def cbc_encrypt(self, data: bytes, iv: bytes) -> bytes:
        """CBC encrypt with PKCS#7 padding."""
        if len(iv) != 16:
            raise BackendError("AES IV must be 16 bytes")
        pad = 16 - (len(data) % 16)
        padded = data + bytes([pad]) * pad
        out = bytearray()
        prev = iv
        for off in range(0, len(padded), 16):
            block = bytes(a ^ b for a, b in zip(padded[off : off + 16], prev))
            prev = self.encrypt_block(block)
            out += prev
        return bytes(out)

    def cbc_decrypt(self, data: bytes, iv: bytes) -> bytes:
        """CBC decrypt without removing padding (BIP-38 style raw decryption)."""
        if len(iv) != 16:
            raise BackendError("AES IV must be 16 bytes")
        if len(data) % 16:
            raise BackendError("CBC ciphertext must be a multiple of 16 bytes")
        out = bytearray()
        prev = iv
        for off in range(0, len(data), 16):
            block = data[off : off + 16]
            plain = self.decrypt_block(block)
            out += bytes(a ^ b for a, b in zip(plain, prev))
            prev = block
        return bytes(out)


def encrypt_block(key: bytes, block: bytes) -> bytes:
    return AES256ECB(key).encrypt_block(block)


def decrypt_block(key: bytes, block: bytes) -> bytes:
    return AES256ECB(key).decrypt_block(block)


def cbc_encrypt(key: bytes, iv: bytes, data: bytes) -> bytes:
    return AES256ECB(key).cbc_encrypt(data, iv)


def cbc_decrypt(key: bytes, iv: bytes, data: bytes) -> bytes:
    return AES256ECB(key).cbc_decrypt(data, iv)
