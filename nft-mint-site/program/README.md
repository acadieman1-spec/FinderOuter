# chromafield-mint — Solana program

Anchor program that mints the CHROMAFIELD collection: one instruction takes payment,
creates an SPL token mint (decimals 0, supply 1), drops the mint authority, writes
Metaplex Token Metadata with a zero-supply master edition, and enforces the schedule,
allowlist and per-wallet cap.

> **Status:** source-complete, **not compiled in the sandbox this was written in** (no
> Rust/Anchor toolchain available). Run `anchor build && anchor test` locally before you
> deploy anything, and treat an external audit as a prerequisite for mainnet.

## Layout

```
program/
├── Anchor.toml                 anchor 0.30.1, devnet/localnet program ids
├── Cargo.toml                  workspace
├── package.json                deploy/test tooling (ts-node, anchor, spl-token)
├── programs/chromafield-mint/
│   └── src/
│       ├── lib.rs              instructions + account structs (order is load-bearing)
│       ├── state.rs            Collection / MintState / WalletState + PDA seeds
│       ├── error.rs            error codes 6000–6011 (mirrored by the dApp)
│       └── merkle.rs           keccak sorted-pair verification (+ unit tests)
├── scripts/
│   ├── merkle.ts               allowlist root + proofs generator
│   └── init-collection.ts      creates the Collection account from env vars
└── tests/chromafield-mint.ts   anchor test: gates, payment, cap, auth
```

## Build and deploy

```bash
cd program
npm install

# Requires the Solana CLI + Anchor CLI + Rust (stable).
anchor build                       # → target/deploy/chromafield_mint.so + IDL
solana-keygen new -o target/deploy/chromafield-mint-keypair.json
anchor keys list                   # prints the program id for that keypair
```

Paste that program id into:

1. `Anchor.toml` (`[programs.devnet]` / `[programs.localnet]`)
2. `programs/chromafield-mint/src/lib.rs` (`declare_id!`)
3. the site: `src/config.ts` → `PLACEHOLDER_PROGRAM_ID`, or `VITE_PROGRAM_ID`, or the
   settings drawer at runtime.

Then rebuild and deploy:

```bash
anchor build && anchor deploy --provider.cluster devnet
```

### Initialise the collection

```bash
# 1. Build the allowlist root
printf '%s\n' "$YOUR_WALLET" "$FRIEND_1" "$FRIEND_2" > allowlist.txt
npx ts-node scripts/merkle.ts allowlist.txt --out proofs.json

# 2. Create the Collection account
TREASURY=<treasury-pubkey> \
PRICE_SOL=0.35 ALLOWLIST_PRICE_SOL=0.25 \
MAX_SUPPLY=2048 ALLOWLIST_ALLOCATION=768 MAX_PER_WALLET=4 \
ALLOWLIST_ROOT_HEX=<root from step 1> \
ALLOWLIST_START=2026-10-08T18:00:00Z \
PUBLIC_START=2026-10-14T18:00:00Z \
ENDS_AT=2026-10-28T18:00:00Z \
URI_BASE=https://chromafield.dev/api/meta/ \
npx ts-node scripts/init-collection.ts

# 3. Run the tests against a local validator
anchor test
```

## Instructions

| Instruction | Auth | Purpose |
|---|---|---|
| `initialize_collection(args)` | authority | Creates the `Collection` PDA (price, supply, schedule, root, URI base). |
| `set_allowlist_root(root)` | authority | Rotates the Merkle root (giveaways, corrections). |
| `update_phase(phase, paused)` | authority | Sets phase 0–3 and the pause flag. |
| `mint_nft(proof)` | anyone | Mints one token. `proof` is `Vec<[u8; 32]>`; required inside the allowlist window, ignored afterwards. |
| `withdraw()` | authority | Sweeps the collection account balance above its rent floor to the treasury. |

Payment always goes to `collection.treasury` by `system_program::transfer` — the allowlist
window charges `allowlist_price_lamports`, the public window charges `price_lamports`.
Token indices come from `collection.total_minted`, so nobody (including the authority) can
choose a rare seed.

## PDAs

| Account | Seeds | Owner |
|---|---|---|
| `collection` | `["collection"]` | program |
| `mint_state` | `["mint_state", mint]` | program |
| `wallet_state` | `["wallet_state", receiver]` | program |
| `metadata` | `["metadata", metadata_program, mint]` | Metaplex |
| `master_edition` | `["metadata", metadata_program, mint, "edition"]` | Metaplex |
| `receiver_token_account` | SPL associated token account | token program |

## Account order for `mint_nft`

The dApp builds this instruction by hand (`nft-mint-site/src/lib/mint.ts`). If you change
this struct, change that file in the same commit.

```
00 payer                    signer, writable
01 collection               writable PDA
02 mint_state               writable PDA (init)
03 mint                     signer (client keypair), writable
04 metadata                 writable (Metaplex PDA)
05 master_edition           writable (Metaplex PDA)
06 receiver_token_account   writable ATA (init_if_needed)
07 receiver                 the wallet that owns the NFT
08 wallet_state             writable PDA (init_if_needed) — per-wallet cap
09 treasury                 writable, must equal collection.treasury
10 token_program
11 associated_token_program
12 metadata_program
13 system_program
14 sysvar_instructions
```

## Error codes

6000 SoldOut · 6001 MintNotLive · 6002 MintEnded · 6003 NotAllowlisted ·
6004 AllowlistExhausted · 6005 InsufficientPayment · 6006 Paused ·
6007 MaxPerWalletExceeded · 6008 AlreadyMinted (reserved) · 6009 Unauthorized ·
6010 InvalidPhase · 6011 NothingToWithdraw

The site maps these to copy in `nft-mint-site/src/lib/mint.ts` (`PROGRAM_ERRORS`), and also
parses them back out of transaction logs when a broadcast fails.

## Security notes

- `has_one = authority` guards every admin instruction; the treasury address is
  `address`-checked against the stored value, so proceeds cannot be redirected.
- The mint keypair is client-generated and must sign, which makes a replayed mint fail on
  the `init` constraint for `mint_state`.
- Mint authority is set to `None` immediately after minting: exactly one unit can exist.
- `print_supply = Zero` and `is_mutable = false` on the metadata record.
- Merkle leaves are `keccak256(pubkey_bytes)` with sorted-pair inner nodes; an empty proof
  against a single-leaf tree is valid by design, so never ship a one-address allowlist
  without also checking `allowlist_allocation`.
