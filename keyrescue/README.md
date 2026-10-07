# KeyRescue

Offline recovery of **your own** Bitcoin keys, mnemonics and passphrases, from one
command line tool.

KeyRescue searches the small space around something you almost know: a private key
with a few unreadable characters, a 12-word phrase with one word smudged, a BIP-38
paper wallet whose password you half remember, a `wallet.dat` you locked with a
password you no longer trust yourself to type. It never touches the network, never
uploads anything, and stops the moment it finds the key that matches the address you
already have.

**Use it only on wallets and keys you own or have written authority to recover.**
It is built for that: every mode needs a *known* target (an address, a public key or
a checksum) and there is deliberately no "sweep random keys against the blockchain"
mode, no network code and no support for attacking logins, SSH keys or password
hashes. Modes that try passphrases additionally require `--i-own-this`.

---

## Install

```bash
pip install ./keyrescue                       # from a checkout
pip install "./keyrescue[fast,crypto]"         # + libsecp256k1 and AES accelerators
```

Requirements: Python 3.9+. The package has **no required dependencies** — pure
Python fallbacks exist for secp256k1, RIPEMD-160 and AES. Install the extras and it
gets faster:

| extra | what it buys |
| --- | --- |
| `[fast]` | `coincurve` — public key derivation roughly 100× faster (address matching) |
| `[crypto]` | `pycryptodome` — AES (BIP-38, `wallet.dat`) and accelerated RIPEMD-160 |
| `[dev]` | pytest and both accelerators, for working on the code |

`keyrescue doctor` tells you which backends are actually active:

```
$ keyrescue doctor
backends
  secp256k1:      coincurve
  AES:            pycryptodome
  RIPEMD-160:     accelerated
  workers:        8 usable CPUs
```

## Five minute quick start

You need two things: the **damaged string** and a **target** (an address you know the
funds sit on, or a public key). Mark unreadable characters with `?`.

```bash
# 1. A hex private key with one character unreadable
keyrescue hex --input "0c28fca386c7a227600b2fe50b7cae11ec86d3bf1fbe471be89827e19d72aa1?" \
              --target 1GAehh7TsJAHuUAeKZcXf5CnwuGuGgyX2S

# 2. A damaged Casascius / paper-wallet minikey (30 characters, starts with S)
keyrescue minikey --input "S6c56bnXQiBjk9mqSYE7ykVQ7Nz?Ry" \
                  --target 1CciesT23BNionJeXrbxmjc7ywfiyM4oLW

# 3. One missing BIP-39 word, checked against the first receiving address
keyrescue mnemonic --input "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon ?" \
                   --path "m/44'/0'/0'/0/0" --target 1LqBGSKuX5yYUonjxT5qGfpUsXKYYWeabA

# 4. A BIP-38 encrypted key and a list of passwords you might have used
keyrescue bip38 --input 6PRVWUbkzzsbcVac2qwfssoUJAN1Xhrg6bNk8J7Nzm5H7kxEbn2Nh2ZoGg \
                --words guesses.txt --i-own-this

# 5. A locked bitcoin-core wallet
keyrescue wallet --file ~/bitcoin/wallets/wallet.dat --words guesses.txt --i-own-this
```

On a match KeyRescue prints everything you need to move the funds and exits `0`;
no match exits `1`; anything you can act on (bad input, licence) exits `2` or `3`:

```
========================================================================
  RECOVERED (1 match)
========================================================================

0c28fca386c7a227600b2fe50b7cae11ec86d3bf1fbe471be89827e19d72aa1d: private key found: ...
    privkey hex              0c28fca386c7a227600b2fe50b7cae11ec86d3bf1fbe471be89827e19d72aa1d
    wif compressed           KwdMAjGmerYanjeui5SHS7JkmpZvVipYvB2LJGU1ZxJwYvP98617
    wif uncompressed         5HueCGU8rMjxEXxiPuD5BDku4MkFqeZyd4dZ1jvhTVqvbTLvyTJ
    pubkey compressed        02d0de0aaeaefad02b8bdc8a01a1b8b11c696bd3d66a2c5f10780d95b7df42645c
    address compressed p2pkh 1LoVGDgRs9hTfTNJNuXKSpywcbdvwRXpmK
    ...
checked 16 of 16 candidates in 0.00s
```

**Treat that output as a private key.** Save it somewhere safe and delete the
terminal scrollback; `keyrescue` never sends it anywhere.

## The modes

| mode | recovers | cost per candidate |
| --- | --- | --- |
| `hex` | missing characters in a 64 character hex private key | ~30 µs |
| `base58` | missing characters in a WIF key, an address or a BIP-38 string | ~8 µs |
| `minikey` | a damaged mini private key (Casascius coins, 22/26/30 chars) | ~2 µs |
| `mnemonic` | missing or partially readable BIP-39 / Electrum words | ~1.8 ms |
| `passphrase` | the 25th word / seed extension of a known mnemonic | ~1.6 ms |
| `bip38` | the passphrase of a `6P...` encrypted key | ~380 ms (scrypt) |
| `wallet` | the password of a bitcoin-core `wallet.dat` | ~33 µs per 25 k iterations |

The per-candidate costs above are what `keyrescue benchmark` measures, and the
estimates `--estimate` prints are computed from them (the `wallet` mode takes its
cost from the iteration count recorded in your wallet file, not a guess).

Every mode takes `--input`/`-i` or `--file`/`-f`, `--target`, `--threads`,
`--session` and the reporting flags; `keyrescue <mode> --help` lists the rest.

Two commands help before and after a run: `keyrescue <mode> --estimate` prints the
size of the search and an expected time, and `keyrescue info <string>` identifies
anything you pasted — an address, WIF, hex key, minikey, BIP-38 record or mnemonic
— and shows the addresses it implies, which is how you check a partially legible
Casascius coin against the prefix printed on the back.

## Writing a damaged key

The template syntax is shared by the character modes (`hex`, `base58`, `minikey`):

| you write | meaning |
| --- | --- |
| `?` or `*` | one unknown character, any of the charset |
| `{4}` | four unknown characters (handy for long damage runs) |
| `{0-9a-f}` | one character from this explicit set |
| `{0o}` | one character, but you are sure it is a zero or a capital O |
| `\?` | a literal question mark |

`--charset` changes what `?` means, by name (`hex`, `base58`, `alnum`, `lower`,
`lowernum`, `digits`, `all`) or literally, and `--charset file:chars.txt` reads it
from a file. If you are not sure whether a smudge is `0` or `O`, `5` or `S`,
narrow the charset to the plausible group instead of searching all of Base-58:

```bash
keyrescue base58 -i "5HueCGU8rMjxEXxiPuD5BDku4MkFqeZyd4dZ1jvhTVqvbT?vbTLvyTJ" \
                 --target 1GAehh7TsJAHuUAeKZcXf5CnwuGuGgyX2S --charset "5Ss"
```

For mnemonics, one word per `?`, or a prefix pattern (`abou?` matches only `about`
in the English list), and `--language`/`--wordlist` for a non-English list.

## Sizing a search before running it

```bash
$ keyrescue hex -i "0c28fca386c7a227600b2fe50b7cae11ec86d3bf1fbe471be89827e1{8}" \
                --target 1GAehh7TsJAHuUAeKZcXf5CnwuGuGgyX2S --estimate
search space: 8 unknown position(s), 4,294,967,296 candidates
total candidates: 4,294,967,296
estimated time:   19h 41m 06s on 2 core(s)
```

Estimates are always available, even for spaces far above your licence limit, so
you can decide whether to narrow the search (`--charset`, `--length`, one more
legible character) before committing time to it.

`keyrescue benchmark` measures *this* machine instead of guessing:

```
hex (address match)                      32.14 k/s
base58 (checksum filter)                135.92 k/s
minikey (marker + address)              663.00 k/s
mnemonic (PBKDF2 + path + address)         569.4/s
passphrase (PBKDF2 only)                   614.3/s
bip38 (scrypt N=16384)                       2.6/s
wallet.dat (1000 iterations)            760.47 k/s
```

Those are single-core numbers from a 2 vCPU box with both extras installed
(libsecp256k1 for the derivation, pycryptodome for AES); more cores scale roughly
linearly via `--threads`, and note that `bip38` is scrypt-bound by design — that is
what makes BIP-38 safe, and what makes a long dictionary impractical. Without
`[fast]`, address matching is slower because the pure Python curve is used.

## Long runs, and walking away from one

```bash
keyrescue mnemonic -i "abandon ... ?" --target bc1q... --threads 16 \
                   --session holiday.json                    # writes progress
^C                                                            # interrupt any time
keyrescue mnemonic -i "abandon ... ?" --target bc1q... --session holiday.json --resume
```

The session file records the mode, the exact search parameters and the position it
reached, so `--resume` refuses to continue if you changed the input, the target or
the charset. Interrupting is safe: KeyRescue never repeats work it recorded as done
and re-checks at most one chunk. `--max-candidates N` is the other useful one — it
turns a huge space into a bounded probe.

## Reports

```bash
keyrescue hex -i damaged.txt --target 1B... --report result.json     # JSON on disk
keyrescue bip38 -i 6P... --words guesses.txt --i-own-this --report run.txt
keyrescue ... --json | jq '.results[0].detail.p2wpkh'
```

JSON reports **omit** recovered secrets by default, so a report can be emailed to
support or filed in a ticket without leaking a key; add `--include-secrets` when the
report is the thing you are keeping.

## Licences and tiers

Recovery is CPU work, so the licence controls how much of your machine a run may
use. Licensing is fully offline — a key is an Ed25519 signature over its own
claims, verified against the vendor public key compiled into the build, so it works
on an air-gapped machine and cannot be activated by copying a config file between
builds.

| tier | candidates per run | cores | resume sessions |
| --- | --- | --- | --- |
| Free | 1,000,000 | 1 | – |
| Trial | unlimited | all | yes |
| Pro | unlimited | all | yes |
| Team | unlimited | all | yes (named seats) |

```bash
keyrescue license tiers                  # what each tier includes
keyrescue license verify "KR1-..."       # check a key without activating it
keyrescue license activate "KR1-..."     # store it in ~/.config/keyrescue/license.key
keyrescue license show
```

`KEYRESCUE_LICENSE` (a key) and `KEYRESCUE_LICENSE_PATH` (an alternate file) are
honoured for unattended and container use. An expired key falls back to Free limits
and says so on every run, so a licence lapse degrades instead of bricking a
recovery in progress.

Selling it? Issue keys with the bundled vendor tool — it stays out of the wheel:

```bash
python tools/keygen.py pair --out ~/keyrescue-vendor       # once, offline
python tools/keygen.py license --seed-file ~/keyrescue-vendor/vendor.seed \
    --tier pro --name "Jane Doe" --id order-4217 --exp --valid-days 365
```

then paste the printed public key into `src/keyrescue/licensing/keys.py`
(`VENDOR_PUBLIC_KEYS`) before building. See `LICENSE` and
`THIRD_PARTY_NOTICES.md`.

## How it decides a candidate is right

Getting a *false negative* costs time; getting a *false positive* — a private key
you then import and trust — costs money. So matching is strict:

* `hex` compares HASH160 of both the compressed and uncompressed public key against
  the target address (and accepts a raw public key or HASH160 as the target).
* `base58` on a damaged **address** uses the Base-58 checksum, then verifies the
  address decodes to a sane pay-to-key script; `--address-type` narrows it further.
* `minikey` requires the format's own check (`SHA256(key + "?")` starts with a zero
  byte) *and* the address you supply.
* `mnemonic` derives the seed, the child at `--path`, and compares; 2-of-3 checksum
  work is skipped for candidates that cannot be valid mnemonics, which is what makes
  a 2048× space affordable.
* `bip38` and `wallet` verify themselves: a BIP-38 record embeds a hash of its own
  address, and a `wallet.dat` master key has a padding check — both must pass before
  anything is reported, so no candidate is ever "probably right".

## Security notes

* **Offline by construction.** There is no network code in the package; nothing is
  looked up on a blockchain or sent to a server. Running on a machine with no
  connectivity, and no wallet loaded, is still the safest way to do a long search.
* **Recovered keys are printed.** Keep them out of shared terminals, chat logs and
  crash reports; use `--report` on encrypted storage if you need a file.
* **Verify before you move funds.** Take the address KeyRescue prints for a found
  key and check it against the address you expected, and check the balance with your
  own node or a read-only wallet, before importing anything into a spending wallet.
* A recovery run is a search over a space *you* defined: if KeyRescue reports no
  match, that means the answer was not inside the space you described — narrow the
  damage markers, add the missing variants, or re-check the target.

## Development

```bash
pip install -e ".[dev]"
pytest                                    # 293 tests, ~17 s
KEYRESCUE_BACKEND=pure pytest               # same suite on the stdlib-only paths, ~60 s
python tools/fetch_spec_vectors.py        # refresh BIP vectors from bitcoin/bips (needs network)
python -m build                           # sdist + wheel
```

The test suite is spec-driven: RIPEMD-160 against the reference vectors and OpenSSL,
BIP-32 against both published vectors (every xprv *and* xpub), BIP-39 against the
trezor vectors, BIP-38 against all nine official keys including the EC-multiplied
and lot/sequence ones, Bech32/Bech32m against BIP-173 and BIP-350 (including the
vectors BIP-350 supersedes), the minikey sample from the Bitcoin Wiki, and the
licence signature against RFC 8032 and NaCl in both directions. `tests/vectors/`
holds the published vectors; the tests themselves run offline.

`KEYRESCUE_BACKEND=pure` makes the package ignore every optional accelerator, so a
developer with `coincurve` installed can still prove the fallback that bare
installs use. Run the suite both ways before shipping (`make`-style: `pytest` then
`KEYRESCUE_BACKEND=pure pytest`); `keyrescue doctor` reports which backends are
live and says when the override is active.

Layout: `crypto/` (primitives and formats), `search/` (spaces, runner, sessions,
charsets), `engines/` (one module per mode), `licensing/` (tiers, Ed25519, key
store), plus `cli.py`, `reporting.py`, `benchmark.py`.

## Support

support@keyrescue.example.com — include `keyrescue doctor` output and, if relevant,
a `--json` report (secrets are omitted by default). Do not email private keys.

## Licence

Proprietary; see `LICENSE`. KeyRescue adapts algorithms from the MIT-licensed
[FinderOuter](https://github.com/FinderOuter/FinderOuter) project and implements
published Bitcoin standards — attributions, and the third-party notices that must
accompany any redistribution, are in `THIRD_PARTY_NOTICES.md`.
