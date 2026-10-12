/**
 * Client side of the CHROMAFIELD mint program.
 *
 * Mirrors `program/programs/chromafield-mint/src/lib.rs`:
 *   • Anchor instruction discriminators (sha256("global:<name>")[0..8])
 *   • Account PDA seeds
 *   • Borsh layout of the `Collection` / `MintState` accounts
 *
 * Nothing here imports @solana/web3.js at module scope — the live path loads it
 * dynamically (see `withWeb3`) so Demo Mode boots without touching Solana code.
 */

import { CONTRACT } from '@/config'
import { base58Decode, base58Encode } from './base58'

/* ------------------------------------------------------- discriminators */

/** sha256("global:<snake_case_method>")[0..8] — verified against anchor-lang. */
export const DISCRIMINATORS = {
  initializeCollection: [112, 62, 53, 139, 173, 152, 98, 93],
  setAllowlistRoot: [145, 238, 252, 173, 15, 3, 94, 23],
  updatePhase: [192, 90, 97, 235, 207, 129, 59, 5],
  mintNft: [211, 57, 6, 167, 15, 219, 35, 251],
  withdraw: [183, 18, 70, 156, 148, 109, 161, 34],
} as const

/** sha256("account:<Name>")[0..8] */
export const ACCOUNT_DISCRIMINATORS = {
  Collection: [0x30, 0xa0, 0xe8, 0xcd, 0xbf, 0xcf, 0x1a, 0x8d],
  MintState: [0x2f, 0xfc, 0x8e, 0x7e, 0xf1, 0xa2, 0x74, 0xbc],
} as const

export const PHASE = {
  notStarted: 0,
  allowlist: 1,
  public: 2,
  ended: 3,
} as const

export type PhaseValue = (typeof PHASE)[keyof typeof PHASE]

export const PHASE_LABEL: Record<PhaseValue, string> = {
  0: 'Not started',
  1: 'Allowlist',
  2: 'Public',
  3: 'Ended',
}

/* ------------------------------------------------------------ accounts */

export interface CollectionState {
  authority: string
  treasury: string
  priceLamports: bigint
  allowlistPriceLamports: bigint
  maxSupply: number
  totalMinted: number
  allowlistMinted: number
  allowlistAllocation: number
  maxPerWallet: number
  royaltyBps: number
  phase: PhaseValue
  paused: boolean
  bump: number
  allowlistRoot: string
  allowlistStart: number
  publicStart: number
  endsAt: number
  uriBase: string
  name: string
  symbol: string
  generatorVersion: string
}

export interface MintState {
  mint: string
  owner: string
  tokenIndex: number
  phase: PhaseValue
  mintedAt: number
  bump: number
}

/** Little-endian Borsh reader matching the Rust structs field-for-field. */
class BorshReader {
  private offset = 0
  constructor(private readonly data: Uint8Array) {}

  get remaining(): number {
    return this.data.length - this.offset
  }

  u8(): number {
    return this.data[this.offset++]
  }

  bool(): boolean {
    return this.u8() !== 0
  }

  u16(): number {
    const view = new DataView(this.data.buffer, this.data.byteOffset + this.offset, 2)
    this.offset += 2
    return view.getUint16(0, true)
  }

  u32(): number {
    const view = new DataView(this.data.buffer, this.data.byteOffset + this.offset, 4)
    this.offset += 4
    return view.getUint32(0, true)
  }

  u64(): bigint {
    const view = new DataView(this.data.buffer, this.data.byteOffset + this.offset, 8)
    this.offset += 8
    return view.getBigUint64(0, true)
  }

  i64(): number {
    const raw = this.u64()
    return Number(raw > 0x7fffffffffffffffn ? raw - 0x10000000000000000n : raw)
  }

  bytes(len: number): Uint8Array {
    const out = this.data.slice(this.offset, this.offset + len)
    this.offset += len
    return out
  }

  pubkey(): string {
    return base58Encode(this.bytes(32))
  }

  string(): string {
    const len = this.u32()
    return new TextDecoder().decode(this.bytes(len))
  }

  discriminator(): string {
    return base58Encode(this.bytes(8))
  }
}

function hasDiscriminator(data: Uint8Array, expected: readonly number[]): boolean {
  if (data.length < 8) return false
  for (let i = 0; i < 8; i++) if (data[i] !== expected[i]) return false
  return true
}

/** Decode the global `Collection` PDA. Returns null if absent/mismatched. */
export function decodeCollection(data: Uint8Array | null | undefined): CollectionState | null {
  if (!data || !hasDiscriminator(data, ACCOUNT_DISCRIMINATORS.Collection)) return null
  try {
    const r = new BorshReader(data)
    r.discriminator()
    // Field order mirrors `Collection` in program/.../src/state.rs.
    return {
      authority: r.pubkey(),
      treasury: r.pubkey(),
      priceLamports: r.u64(),
      allowlistPriceLamports: r.u64(),
      maxSupply: r.u32(),
      totalMinted: r.u32(),
      allowlistMinted: r.u32(),
      allowlistAllocation: r.u32(),
      maxPerWallet: r.u32(),
      royaltyBps: r.u16(),
      phase: r.u8() as PhaseValue,
      paused: r.bool(),
      bump: r.u8(),
      allowlistRoot: base58Encode(r.bytes(32)),
      allowlistStart: r.i64(),
      publicStart: r.i64(),
      endsAt: r.i64(),
      uriBase: r.string(),
      name: r.string(),
      symbol: r.string(),
      generatorVersion: r.string(),
    }
  } catch {
    return null
  }
}

/** Decode a per-mint `MintState` PDA. */
export function decodeMintState(data: Uint8Array | null | undefined): MintState | null {
  if (!data || !hasDiscriminator(data, ACCOUNT_DISCRIMINATORS.MintState)) return null
  try {
    const r = new BorshReader(data)
    r.discriminator()
    return {
      mint: r.pubkey(),
      owner: r.pubkey(),
      tokenIndex: r.u32(),
      phase: r.u8() as PhaseValue,
      mintedAt: r.i64(),
      bump: r.u8(),
    }
  } catch {
    return null
  }
}

/* -------------------------------------------------- instruction encoding */

/**
 * Borsh `Vec<[u8; 32]>` — u32 LE length, then the 32-byte leaves in order.
 * Proofs are supplied as hex (the format `scripts/merkle.ts` emits).
 */
export function encodeProof(proof: readonly string[]): Uint8Array {
  const out = new Uint8Array(4 + proof.length * 32)
  new DataView(out.buffer).setUint32(0, proof.length, true)
  proof.forEach((leaf, i) => {
    const bytes = hexToBytes(leaf)
    if (bytes.length !== 32) throw new Error(`Merkle proof element must be 32 bytes, got ${bytes.length}`)
    out.set(bytes, 4 + i * 32)
  })
  return out
}

function hexToBytes(hex: string): Uint8Array {
  const clean = hex.replace(/^0x/, '')
  const out = new Uint8Array(Math.ceil(clean.length / 2))
  for (let i = 0; i < out.length; i++) out[i] = parseInt(clean.slice(i * 2, i * 2 + 2), 16)
  return out
}

/** `mint_nft(proof: Vec<[u8;32]>)` */
export function encodeMintNftData(proof: readonly string[] = []): Uint8Array {
  const disc = Uint8Array.from(DISCRIMINATORS.mintNft)
  const body = encodeProof(proof)
  const out = new Uint8Array(disc.length + body.length)
  out.set(disc, 0)
  out.set(body, disc.length)
  return out
}

/** `update_phase(phase: u8)` */
export function encodeUpdatePhaseData(phase: PhaseValue): Uint8Array {
  const out = new Uint8Array(9)
  out.set(DISCRIMINATORS.updatePhase, 0)
  out[8] = phase
  return out
}

/** `withdraw()` */
export function encodeWithdrawData(): Uint8Array {
  return Uint8Array.from(DISCRIMINATORS.withdraw)
}

/**
 * Associated Token Account program, `CreateIdempotent` (data = [1]).
 * Account order: funder, wallet, mint, ata, system, token program.
 */
export const ATA_ACCOUNT_ORDER = ['funder', 'wallet', 'mint', 'ata', 'system', 'tokenProgram'] as const

export function encodeCreateAtaIdempotent(): Uint8Array {
  return Uint8Array.from([1])
}

/* ------------------------------------------------------- PDA derivation */

/**
 * PDA helpers. `withWeb3` lazy-loads @solana/web3.js so demo mode stays light.
 */
export type Web3 = typeof import('@solana/web3.js')

let web3Promise: Promise<Web3> | null = null
export function withWeb3(): Promise<Web3> {
  if (!web3Promise) {
    web3Promise = import('@solana/web3.js').catch((err) => {
      web3Promise = null
      throw err
    })
  }
  return web3Promise
}

export async function deriveCollectionPda(programId: string): Promise<string> {
  const web3 = await withWeb3()
  const [pda] = web3.PublicKey.findProgramAddressSync(
    [new TextEncoder().encode(CONTRACT.seeds.collection)],
    new web3.PublicKey(programId),
  )
  return pda.toBase58()
}

/** Metaplex metadata PDA for a mint: ["metadata", metadata_program, mint]. */
export async function deriveMetadataPda(mint: string): Promise<string> {
  const web3 = await withWeb3()
  const [pda] = web3.PublicKey.findProgramAddressSync(
    [
      new TextEncoder().encode(CONTRACT.seeds.metadata),
      new web3.PublicKey(CONTRACT.metadataProgramId).toBuffer(),
      new web3.PublicKey(mint).toBuffer(),
    ],
    new web3.PublicKey(CONTRACT.metadataProgramId),
  )
  return pda.toBase58()
}

/**
 * Metaplex master edition PDA: ["metadata", metadata_program, mint, "edition"].
 * CreateV1 writes it with `print_supply = Zero`, so no prints can ever exist.
 */
export async function deriveMasterEditionPda(mint: string): Promise<string> {
  const web3 = await withWeb3()
  const [pda] = web3.PublicKey.findProgramAddressSync(
    [
      new TextEncoder().encode(CONTRACT.seeds.metadata),
      new web3.PublicKey(CONTRACT.metadataProgramId).toBuffer(),
      new web3.PublicKey(mint).toBuffer(),
      new TextEncoder().encode(CONTRACT.seeds.edition),
    ],
    new web3.PublicKey(CONTRACT.metadataProgramId),
  )
  return pda.toBase58()
}

/** Per-wallet counter PDA: ["wallet_state", receiver] — enforces max_per_wallet. */
export async function deriveWalletStatePda(programId: string, receiver: string): Promise<string> {
  const web3 = await withWeb3()
  const [pda] = web3.PublicKey.findProgramAddressSync(
    [new TextEncoder().encode(CONTRACT.seeds.walletState), new web3.PublicKey(receiver).toBuffer()],
    new web3.PublicKey(programId),
  )
  return pda.toBase58()
}

/** Per-mint state PDA: ["mint_state", mint]. */
export async function deriveMintStatePda(programId: string, mint: string): Promise<string> {
  const web3 = await withWeb3()
  const [pda] = web3.PublicKey.findProgramAddressSync(
    [new TextEncoder().encode(CONTRACT.seeds.mintState), new web3.PublicKey(mint).toBuffer()],
    new web3.PublicKey(programId),
  )
  return pda.toBase58()
}

/** Classic SPL associated token account address. */
export async function deriveAta(wallet: string, mint: string): Promise<string> {
  const web3 = await withWeb3()
  const [pda] = web3.PublicKey.findProgramAddressSync(
    [
      new web3.PublicKey(wallet).toBuffer(),
      new web3.PublicKey(CONTRACT.tokenProgramId).toBuffer(),
      new web3.PublicKey(mint).toBuffer(),
    ],
    new web3.PublicKey(CONTRACT.ataProgramId),
  )
  return pda.toBase58()
}

/* --------------------------------------------------------- explorer urls */

export function explorerUrl(kind: 'tx' | 'account', value: string, network: string, base?: string) {
  const cluster =
    network === 'mainnet-beta' ? 'https://solscan.io' : 'https://explorer.solana.com'
  const root = base ?? cluster
  const suffix = network === 'mainnet-beta' ? '' : `?cluster=${network}`
  return `${root}/${kind}/${value}${suffix}`
}

/** Byte length of a legacy SPL token mint account (no extensions). */
export const MINT_ACCOUNT_SPACE = 82

/**
 * Rent-exempt minimum for an account of `space` bytes, in lamports.
 * Mirrors `Rent::default().minimum_balance(space)`:
 *   (space + 128) * lamports_per_byte_year * exemption_threshold
 * → 82-byte SPL mint account = 1_461_600 lamports (0.0014616 SOL).
 */
export function rentExemptLamports(space: number): bigint {
  const LAMPORTS_PER_BYTE_YEAR = 3480n
  const EXEMPTION_THRESHOLD_NUM = 2n // 2.0 years
  return BigInt(space + 128) * LAMPORTS_PER_BYTE_YEAR * EXEMPTION_THRESHOLD_NUM
}

export function demoSignatureBytes(seed: number): Uint8Array {
  const bytes = new Uint8Array(64)
  let s = seed >>> 0
  for (let i = 0; i < 64; i++) {
    s = (s * 1664525 + 1013904223) >>> 0
    bytes[i] = (s >>> 24) & 0xff
  }
  return bytes
}

export function demoSignature(seed: number): string {
  return base58Encode(demoSignatureBytes(seed))
}

export function addressFromSeed(seed: string): string {
  const bytes = new Uint8Array(32)
  let h = 2166136261
  for (let i = 0; i < seed.length; i++) {
    h ^= seed.charCodeAt(i)
    h = Math.imul(h, 16777619)
  }
  for (let i = 0; i < 32; i++) {
    h ^= i
    h = Math.imul(h, 2246822519) >>> 0
    bytes[i] = (h >>> 16) & 0xff
  }
  return base58Encode(bytes)
}

/** Sanity check used by the settings drawer before switching to live mode. */
export function validateProgramId(id: string): string | null {
  if (!id || id === 'demo') return null
  const decoded = (() => {
    try {
      return base58Decode(id)
    } catch {
      return null
    }
  })()
  if (!decoded || decoded.length !== 32) return 'Program ID must decode to 32 bytes of base58.'
  return null
}
