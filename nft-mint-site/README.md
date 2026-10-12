# CHROMAFIELD — NFT minting site (Solana)

A complete generative-art NFT drop: marketing site + working mint dApp + the on-chain
Solana program it talks to.

**Defaults to Demo Mode**, so everything is clickable with no wallet extension, no RPC
access and no SOL. Flip to **Live** in the settings drawer (gear icon, top right) once the
program is deployed.

```
nft-mint-site/
├── index.html
├── src/
│   ├── App.tsx                 page composition
│   ├── config.ts               ← collection, schedule, addresses, FAQ, roadmap
│   ├── lib/
│   │   ├── art.ts              the renderer (6 compositions, anomalies, grain)
│   │   ├── traits.ts           deterministic trait + rarity derivation
│   │   ├── prng.ts             seeded RNG, value noise, colour maths
│   │   ├── curation.ts         picks the rarest fields for the hero/gallery
│   │   ├── merkle.ts           keccak sorted-pair Merkle tree (allowlist)
│   │   ├── program.ts          Anchor discriminators, PDAs, Borsh decoding
│   │   ├── mint.ts             the mint stage machine (demo + live paths)
│   │   ├── chain.ts            demo chain simulation / live RPC reads
│   │   ├── wallet.ts           Phantom / Solflare / Backpack + demo signer
│   │   ├── base58.ts           codec used by the demo path
│   │   └── format.ts           SOL, time, address formatting
│   ├── components/             Nav, Hero, MintPanel, Gallery, TokenModal, …
│   ├── state/AppState.tsx      single store: settings, wallet, chain, mint, toasts
│   └── styles/                 global tokens + section styles (no CSS framework)
├── program/                    Anchor program (Rust) + deploy/test tooling
└── tests/                      vitest: pure logic + jsdom interaction tests
```

## Quick start

```bash
cd nft-mint-site
npm install
npm run dev          # http://localhost:5173
npm test             # 41 tests: generator, merkle, encoding, phases, UI flows
npm run build        # type-check + production bundle
```

Requires Node 18+. No backend, no environment variables — `.env.example` lists the
optional overrides.

## Demo Mode vs Live Mode

| | Demo Mode (default) | Live Mode |
|---|---|---|
| Wallet | Simulated signer with a persistent fake address | Injected Phantom / Solflare / Backpack |
| Chain state | `DemoChain` in localStorage; other "people" keep minting while you watch | `Collection` PDA read over RPC, refreshed every 30s |
| Allowlist | A real 768-address Merkle tree rebuilt around your wallet; "Verify my spot" signs a real challenge | Root read from the chain; paste the proof issued with your spot |
| Mint | Staged simulation with realistic latency and a deterministic fake signature | Keypair generation, PDA derivation, instruction build, wallet signature, broadcast, confirmation |
| RPC calls | None | `getAccountInfo`, `getBalance`, `getSignaturesForAddress`, `sendRawTransaction` |

The two paths share one stage machine — `preflight → building → awaiting-signature →
submitting → confirming → complete` — so the UI, the progress copy and the error handling
are identical. Settings also expose two fault injectors ("reject wallet signatures",
"simulate empty wallet") to exercise the failure states.

`@solana/web3.js` is imported **lazily** (`withWeb3()`); Demo Mode never loads it.

## What the mint actually does (Live Mode)

1. Reads the `Collection` PDA → supply, phase, price, treasury, allocation.
2. Checks balance against price + rent + fee, and the phase gates.
3. Generates a fresh mint keypair client-side.
4. Derives `mint_state`, Metaplex `metadata` + `master_edition`, `wallet_state` and the ATA.
5. Builds a legacy transaction: `CreateIdempotent` (ATA) + `mint_nft(proof)`.
6. Partial-signs with the mint keypair, hands it to the wallet for the second signature.
7. Broadcasts, confirms with `lastValidBlockHeight`, and maps Anchor error codes
   (6000–6011) to human-readable copy.

The account order in `src/lib/mint.ts` is numbered and must match `MintNft` in
`program/programs/chromafield-mint/src/lib.rs` — `tests/logic.test.ts` pins the Borsh
layout of the `Collection` account against a hand-encoded fixture so a drift in either
side fails the build.

## The artwork

Nothing is pre-rendered or hosted. `src/lib/art.ts` is a pure canvas renderer:
`token id + generator version → seed → field`.

- **Palettes** (8): Solar Flare, Cyanotype, Coral Reef, Citrus Press, Ultraviolet, Acid
  Bloom, Magenta Static, Void Prism (2% of supply).
- **Compositions** (6): Flowfield, Strata, Orbital, Rosette, Fracture, Eclipse.
- **Anomalies** (5): Ghost Ring, Chroma Bleed, Void Core, Prism Fracture, none (76%).
- Plus density, luminosity and grain buckets derived from the same stream.

Rarity percentages shown in the UI are **counted** by running the generator over all 2,048
seeds (`buildRarityTable`) — not hand-written. Cards render at `quality: 'fast'`, the hero
and lightbox animate at `time > 0` and pause off-screen or under `prefers-reduced-motion`.
Minted tokens can be exported as a 1024/1600px PNG straight from the canvas.

## Pointing it at your own drop

1. `src/config.ts` — name, symbol, supply, price, per-wallet cap, royalty, schedule,
   links, FAQ, roadmap.
2. `program/` — build and deploy (see [program/README.md](./program/README.md)), then
   paste the program ID into settings (or `VITE_PROGRAM_ID`).
3. `program/scripts/merkle.ts` — publish your allowlist root and hand out proofs.
4. Optional: replace the palette/composition tables in `src/lib/traits.ts` for a different
   look. Bumping `generatorVersion` re-derives every token deterministically.

## Known limits

- The Rust program in `program/` is **source-complete but was not compiled in this
  environment** (no Rust/Anchor toolchain available). Run `anchor build && anchor test`
  before trusting it with real funds, and get it audited for a mainnet drop.
- Live Mode requires a wallet extension; there is no server-side signer or relayer.
- Holders in Live Mode are approximated by `total_minted` (unique-owner counts need a DAS
  `getAssetProof`/indexer call).
- Web fonts load from Google Fonts with system fallbacks.
