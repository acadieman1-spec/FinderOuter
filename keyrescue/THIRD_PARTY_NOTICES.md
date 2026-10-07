Third-party notices
===================

KeyRescue stands on published standards and a small number of open-source
projects.  This file lists them with the attributions their licences require and
must accompany any distribution of the software, including builds made from
source.

FinderOuter
-----------
The search-space model (a damaged key as a template of unknown positions), the
mini private key `Loop27` handling, the Base-58 address/self-check logic, the
BIP-38 decryption flow and the bitcoin-core `mkey` iteration scheme were studied
and re-implemented from FinderOuter, © 2020 Coding Enthusiast, MIT-licensed:
<https://github.com/FinderOuter/FinderOuter> (the `acadieman1-spec/FinderOuter`
fork).  Its licence text is reproduced below and applies to those adapted
algorithms.

    MIT License

    Copyright (c) 2020 Coding Enthusiast

    Permission is hereby granted, free of charge, to any person obtaining a copy
    of this software and associated documentation files (the "Software"), to deal
    in the Software without restriction, including without limitation the rights
    to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
    copies of the Software, and to permit persons to whom the Software is
    furnished to do so, subject to the following conditions:

    The above copyright notice and this permission notice shall be included in all
    copies or substantial portions of the Software.

    THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
    IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
    FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
    AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
    LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
    OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
    SOFTWARE.

Standards and their test vectors
--------------------------------
Specifications and vectors are used as the definition of correct behaviour and as
the source of `tests/vectors/*.json`; they are documentation, not code, and are
referenced by their canonical locations:

* BIP-32 (hierarchical deterministic keys) - test vectors 1 and 2.
* BIP-38 (passphrase-protected private keys) - all nine test vectors.
* BIP-39 (mnemonic code) - the English word list and the reference vectors from
  `trezor/python-mnemonic/vectors.json`.
* BIP-173 / BIP-350 (Bech32 / Bech32m addresses) - valid and invalid vectors.
* BIP-340 / BIP-341 / BIP-342 (Schnorr, Taproot) - tagged hashing and tweaks.
* BIP-49 (nested SegWit) - the P2SH-P2WPKH derivation used in reports.
* Bitcoin Core `src/wallet/crypter.cpp` - the semantics of `BytesToKeySHA512AES`
  and the AES-256-CBC padding check used to recognise a correct wallet password.
* The Bitcoin Wiki article "Mini private key format" - the minikey sample key
  used in `tests/vectors/minikey.json`.

Word lists
----------
`src/keyrescue/data/wordlists/bip39_english.txt` is the BIP-39 English list, and
`electrum_english.txt` is the English list published by Electrum
(© Electrum authors, MIT), which reuses the same 2048 words.  A word's position in
the file is its index, so the files are shipped unmodified and byte-verified by
the test suite.

Optional dependencies
---------------------
KeyRescue runs on the standard library alone.  When present, these accelerate it
and are used through their public APIs only:

* `coincurve` (MIT) - libsecp256k1 bindings, used for public key derivation.
* `pycryptodome` (BSD-2-Clause) - AES and RIPEMD-160.
* `PyNaCl` (Apache-2.0) - *tests only*: an independent Ed25519 oracle for the
  licence signature scheme.
* `pytest` (MIT) - *development only*.

Reference implementations consulted while writing the pure-Python fallbacks
---------------------------------------------------------------------------
The pure-Python RIPEMD-160 in `keyrescue/crypto/hashes.py` was written from the
original paper's published description and cross-checked, while debugging, against
the MIT-licensed reference implementation in `pycoin` (Thomas Kerin),
`pycoin/contrib/ripemd160.py`; both are then compared with OpenSSL and with each
other in `tests/test_hashes.py`.  The Ed25519 implementation follows RFC 8032.

No GPL-licensed or AGPL-licensed code is used anywhere in this project, so the
proprietary licence of KeyRescue is not affected by copyleft obligations.
