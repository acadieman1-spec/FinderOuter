/**
 * Single source of truth for the collection.
 * Everything the marketing site + mint dApp show is driven from here, so a
 * rebrand is a one-file change. On-chain values win in Live mode (see
 * `src/lib/program.ts`), these are the display / demo defaults.
 */

export type NetworkId = 'devnet' | 'mainnet-beta' | 'localnet'

export const NETWORKS: Record<
  NetworkId,
  { label: string; short: string; rpc: string; explorer: string; explorerKind: 'solscan' }
> = {
  devnet: {
    label: 'Devnet',
    short: 'DEV',
    rpc: 'https://api.devnet.solana.com',
    explorer: 'https://explorer.solana.com',
    explorerKind: 'solscan',
  },
  'mainnet-beta': {
    label: 'Mainnet Beta',
    short: 'MAIN',
    rpc: 'https://api.mainnet-beta.solana.com',
    explorer: 'https://solscan.io',
    explorerKind: 'solscan',
  },
  localnet: {
    label: 'Local validator',
    short: 'LOCAL',
    rpc: 'http://127.0.0.1:8899',
    explorer: 'https://explorer.solana.com',
    explorerKind: 'solscan',
  },
}

export const COLLECTION = {
  name: 'CHROMAFIELD',
  symbol: 'CHRM',
  tagline: 'Deterministic colour fields, grown from a seed and frozen on Solana.',
  description:
    'Every CHROMAFIELD token is a 2048×2048 field rendered by the same generator you can run in your browser: seed in, artwork out. Nothing is pre-rendered, nothing is hosted on a CDN you do not control — the mint writes the seed and the generator version on-chain, so the field can be re-drawn forever.',
  creator: 'Studio Vellum',
  maxSupply: 2048,
  priceSol: 0.35,
  maxPerWallet: 4,
  royaltyBps: 500,
  generatorVersion: '1.4.0',
  /** Metadata stored per token (uri + on-chain attributes). */
  attributes: ['palette', 'composition', 'density', 'luminosity', 'grain', 'anomaly'],
} as const

/** Placeholder until `anchor deploy` prints the real one — swap via env or the settings drawer. */
export const PLACEHOLDER_PROGRAM_ID = '35tHJjPucUNrFKyMBm8tgxYzZ8tmhHAMYp6G9mVr5AUj'

export const CONTRACT = {
  authority: env('VITE_COLLECTION_AUTHORITY', '6XDtMkSM1EjvwWkn5nH5JNSN3VW24THrUchDQiFinfBV'),
  treasury: env('VITE_TREASURY', '5MtUTGRrZtmc7ApJsDfHevdzW8faZPZHJ3wki6bLswM2'),
  programId: env('VITE_PROGRAM_ID', PLACEHOLDER_PROGRAM_ID),
  /** Seeds used to derive PDAs — must match `state.rs` exactly. */
  seeds: {
    collection: 'collection',
    mintState: 'mint_state',
    walletState: 'wallet_state',
    metadata: 'metadata',
    edition: 'edition',
  },
  metadataProgramId: 'metaqbxxUerdq28cj1RbAWkYQm3ybzjb6a8bt518x1s',
  tokenProgramId: 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA',
  ataProgramId: 'ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL',
  systemProgramId: '11111111111111111111111111111111',
  instructionsSysvarId: 'Sysvar1nstructions1111111111111111111111111',
} as const

/**
 * Mint schedule (UTC). The site derives the live phase from these timestamps,
 * so moving the drop is a two-line edit.
 */
export const SCHEDULE = {
  allowlistStart: Date.UTC(2026, 9, 8, 18, 0, 0), //  8 Oct 2026 18:00 UTC — already open
  publicStart: Date.UTC(2026, 9, 14, 18, 0, 0), // 14 Oct 2026 18:00 UTC
  endsAt: Date.UTC(2026, 9, 28, 18, 0, 0), // 28 Oct 2026 18:00 UTC
  allowlistAllocation: 768,
} as const

export const PHASE = {
  allowlistPriceSol: 0.25,
  publicPriceSol: 0.35,
} as const

export const LINKS = {
  x: 'https://x.com/',
  discord: 'https://discord.com/',
  github: 'https://github.com/',
  magicEden: 'https://magiceden.io/',
} as const

export const FAQ = [
  {
    q: 'What exactly am I minting?',
    a: 'A spl-token mint with zero decimals and a supply of one — the Solana equivalent of an ERC-721. Metadata (name, symbol, URI, on-chain attributes) is written through Metaplex Token Metadata at mint time, and the generating seed is embedded in the token URI so the artwork can always be re-derived.',
  },
  {
    q: 'Where does the art live?',
    a: 'The generator does. Each token stores only its seed, generator version and traits; the image you see is rendered locally by the same deterministic code in this page. No IPFS pinning service, no broken images in five years.',
  },
  {
    q: 'How does the allowlist work?',
    a: 'A 32-byte Merkle root is stored in the on-chain Collection account. At mint time you submit your leaf plus a Merkle proof; the program hashes it up to the root and rejects anything that does not match. Use “Verify my spot” to sign a message with your wallet and check your address against the published list.',
  },
  {
    q: 'Why is Demo Mode on by default?',
    a: 'So the whole flow is testable without a funded wallet or a deployed program. Flip to Live in the settings drawer once the program is deployed and your wallet extension is installed — the UI then reads supply, phase and price straight from the chain.',
  },
  {
    q: 'Which wallets are supported?',
    a: 'Any injected Solana provider that implements signTransaction — Phantom, Solflare and Backpack are detected automatically. Hardware wallets work through those adapters.',
  },
  {
    q: 'What are the fees?',
    a: `Mint price ${COLLECTION.priceSol} SOL per token plus roughly 0.0025 SOL of rent and network fees for the mint, metadata and token accounts. Royalties are ${COLLECTION.royaltyBps / 100}% on secondary sales.`,
  },
] as const

export const ROADMAP = [
  {
    at: '0%',
    title: 'Public generator release',
    body: 'The renderer in this page ships as an MIT-licensed package with a reproducible test vector set, so any wallet can verify a field matches its seed.',
    done: true,
  },
  {
    at: '25%',
    title: 'Field study prints',
    body: 'Holders can order archival pigment prints of any token they own, signed and editioned by the studio.',
    done: false,
  },
  {
    at: '50%',
    title: 'Season two seeds',
    body: 'A second generator branch opens to holders: same fields, new palettes and compositions, minted at cost.',
    done: false,
  },
  {
    at: '75%',
    title: 'On-chain composability',
    body: 'Trait attributes move fully on-chain with a program-derived trait registry other collections can read.',
    done: false,
  },
  {
    at: '100%',
    title: 'Studio residency',
    body: 'Treasury funds a two-artist residency; royalties stream to a multisig shared with holder-elected stewards.',
    done: false,
  },
] as const

function env(key: string, fallback: string): string {
  const raw = import.meta.env[key]
  return typeof raw === 'string' && raw.trim().length > 0 ? raw.trim() : fallback
}
