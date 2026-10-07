# Word lists

| file | source | words |
| --- | --- | --- |
| `bip39_english.txt` | https://github.com/bitcoin/bips/blob/master/bip-0039/english.txt | 2048 |
| `electrum_english.txt` | https://github.com/spesmilo/electrum/blob/master/electrum/wordlist/english.txt | 2048 |

Both lists contain the same 2048 English words: Electrum 2.x deliberately reuses
the BIP-39 word list and only differs in how the seed is derived (the salt prefix
`electrum` instead of `mnemonic`) and in how a mnemonic is checked (an HMAC prefix
instead of a SHA-256 checksum). They are kept as separate files because a user may
recover an Electrum seed with a *different* list than BIP-39 would imply, and
because Electrum 1.3 used a 1626 word list that KeyRescue does not bundle
(`keyrescue mnemonic --type electrum` supports the v2 format only).

To refresh these files:

    curl -H 'Accept: application/vnd.github.raw' \
        https://api.github.com/repos/bitcoin/bips/contents/bip-0039/english.txt \
        > src/keyrescue/data/wordlists/bip39_english.txt
    curl -H 'Accept: application/vnd.github.raw' \
        https://api.github.com/repos/spesmilo/electrum/contents/electrum/wordlist/english.txt \
        > src/keyrescue/data/wordlists/electrum_english.txt

Each file must contain exactly 2048 lines, lowercase, no BOM, sorted as published
(the position of a word *is* its index, so re-sorting or re-wrapping breaks it).
