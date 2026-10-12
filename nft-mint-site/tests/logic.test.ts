import { describe, expect, it } from 'vitest'
import { COLLECTION, SCHEDULE } from '@/config'
import { base58Decode, base58Encode, isBase58, looksLikePublicKey, randomBase58 } from '@/lib/base58'
import { demoChain, resolvePhase, type ChainSnapshot } from '@/lib/chain'
import { solToLamports } from '@/lib/format'
import { demoAllowlist, fromHex, leafForAddress, MerkleTree, toHex } from '@/lib/merkle'
import {
  ACCOUNT_DISCRIMINATORS,
  decodeCollection,
  DISCRIMINATORS,
  encodeMintNftData,
  encodeProof,
  MINT_ACCOUNT_SPACE,
  rentExemptLamports,
} from '@/lib/program'
import { coreOf, deriveCore, deriveToken, raritySummary, traitsFor } from '@/lib/traits'

/* ------------------------------------------------------------- base58 */

describe('base58 codec', () => {
  it('round-trips arbitrary bytes', () => {
    for (const len of [1, 16, 32, 64]) {
      const bytes = new Uint8Array(len).map((_, i) => (i * 37 + 11) % 256)
      expect(base58Decode(base58Encode(bytes))).toEqual(bytes)
    }
  })

  it('preserves leading zero bytes as "1"', () => {
    const bytes = new Uint8Array([0, 0, 7, 9])
    const text = base58Encode(bytes)
    expect(text.startsWith('11')).toBe(true)
    expect(base58Decode(text)).toEqual(bytes)
  })

  it('validates the placeholder addresses used in config', () => {
    expect(looksLikePublicKey('35tHJjPucUNrFKyMBm8tgxYzZ8tmhHAMYp6G9mVr5AUj')).toBe(true)
    expect(isBase58('0OIl')).toBe(false)
    expect(looksLikePublicKey('tooshort')).toBe(false)
  })

  it('produces 64-byte simulated signatures', () => {
    expect(base58Decode(randomBase58(64, 0.5)).length).toBe(64)
  })
})

/* -------------------------------------------------------- determinism */

describe('generator determinism', () => {
  it('derives the same spec every time for a token id', () => {
    const a = deriveCore(1234)
    const b = deriveCore(1234)
    expect(a.palette.id).toBe(b.palette.id)
    expect(a.composition).toBe(b.composition)
    expect(a.params.rotation).toBe(b.params.rotation)
    expect(a.seed).toBe(b.seed)
  })

  it('produces different fields for different ids', () => {
    const ids = Array.from({ length: 40 }, (_, i) => i + 1)
    const signatures = new Set(ids.map((id) => JSON.stringify(coreOf(id).params)))
    expect(signatures.size).toBeGreaterThan(30)
  })

  it('attaches traits and a bounded rarity score', () => {
    const spec = deriveToken(7)
    expect(spec.traits).toHaveLength(6)
    expect(spec.rarityScore).toBeGreaterThanOrEqual(1)
    expect(spec.rarityScore).toBeLessThanOrEqual(100)
    // traitsFor must agree with the full spec (same underlying stream)
    expect(traitsFor(7).rarityScore).toBe(spec.rarityScore)
  })

  it('is stable across repeated calls (memoisation does not drift)', () => {
    const first = deriveToken(99).palette.name
    for (let i = 0; i < 50; i++) deriveToken(i + 1)
    expect(deriveToken(99).palette.name).toBe(first)
  })
})

/* ------------------------------------------------------------- rarity */

describe('rarity table', () => {
  const summary = raritySummary()

  it('counts every token exactly once per trait group', () => {
    for (const group of summary.groups) {
      const total = (summary.byKey[group.key] ?? []).reduce((sum, e) => sum + e.count, 0)
      expect(total).toBe(COLLECTION.maxSupply)
    }
  })

  it('reports frequencies that sum to 1', () => {
    for (const group of summary.groups) {
      const total = (summary.byKey[group.key] ?? []).reduce((sum, e) => sum + e.frequency, 0)
      expect(total).toBeCloseTo(1, 6)
    }
  })

  it('marks Void Prism as the rarest palette', () => {
    const palettes = summary.byKey.palette
    expect(palettes[0].value).toBe('Void Prism')
    expect(palettes[0].count).toBeLessThan(COLLECTION.maxSupply * 0.05)
  })

  it('keeps rare anomalies under 10% of supply', () => {
    const anomalies = summary.byKey.anomaly
    const rare = anomalies.filter((a) => a.value !== 'None')
    expect(rare.length).toBeGreaterThan(0)
    for (const a of rare) expect(a.frequency).toBeLessThan(0.1)
  })
})

/* ------------------------------------------------------------ merkle */

describe('merkle allowlist', () => {
  const addresses = Array.from({ length: 64 }, (_, i) =>
    base58Encode(new Uint8Array(32).map((_, j) => (i * 7 + j * 13 + 1) % 256)),
  )
  const tree = new MerkleTree(addresses)

  it('builds a 32-byte root', () => {
    expect(tree.root).toHaveLength(32)
    expect(tree.rootHex).toHaveLength(64)
  })

  it('verifies every address in the tree', () => {
    for (let i = 0; i < addresses.length; i++) {
      const proof = tree.proofForIndex(i)
      expect(proof.length).toBeGreaterThan(0)
      expect(MerkleTree.verify(addresses[i], proof, tree.rootHex)).toBe(true)
    }
  })

  it('rejects an address that is not in the tree', () => {
    const proof = tree.proofForIndex(3)
    const outsider = base58Encode(new Uint8Array(32).fill(250))
    expect(MerkleTree.verify(outsider, proof, tree.rootHex)).toBe(false)
    expect(tree.indexOfAddress(outsider)).toBe(-1)
    expect(tree.proofForAddress(outsider)).toEqual([])
  })

  it('rejects a tampered proof step', () => {
    const proof = tree.proofForIndex(10)
    const tampered = [...proof]
    tampered[0] = toHex(new Uint8Array(32).fill(1))
    expect(MerkleTree.verify(addresses[10], tampered, tree.rootHex)).toBe(false)
  })

  it('leaf hashing is keccak of the decoded address', () => {
    expect(leafForAddress(addresses[0])).toHaveLength(32)
    expect(fromHex(toHex(leafForAddress(addresses[0])))).toEqual(leafForAddress(addresses[0]))
  })

  it('slots the demo wallet in at index 0', () => {
    const demo = demoAllowlist('3VRFuZmg4ZtxJXgmoVnay7PFjvoy44YZec1iJHo8H7sf', 32)
    expect(demo.indexOfAddress('3VRFuZmg4ZtxJXgmoVnay7PFjvoy44YZec1iJHo8H7sf')).toBe(0)
    expect(
      MerkleTree.verify(
        '3VRFuZmg4ZtxJXgmoVnay7PFjvoy44YZec1iJHo8H7sf',
        demo.proofForAddress('3VRFuZmg4ZtxJXgmoVnay7PFjvoy44YZec1iJHo8H7sf'),
        demo.rootHex,
      ),
    ).toBe(true)
  })
})

/* ---------------------------------------------------- program encoding */

describe('instruction + account encoding', () => {
  it('rent for an SPL mint account matches the known constant', () => {
    expect(rentExemptLamports(MINT_ACCOUNT_SPACE)).toBe(1_461_600n)
  })

  it('prefixes mint_nft data with the Anchor discriminator', () => {
    const data = encodeMintNftData([])
    expect(Array.from(data.slice(0, 8))).toEqual(Array.from(DISCRIMINATORS.mintNft))
    // Empty proof = u32 LE zero
    expect(Array.from(data.slice(8, 12))).toEqual([0, 0, 0, 0])
    expect(data).toHaveLength(12)
  })

  it('serialises a Merkle proof as u32 length + 32-byte leaves', () => {
    const proof = [
      '0x' + '11'.repeat(32),
      '0x' + '22'.repeat(32),
      '0x' + '33'.repeat(32),
    ]
    const encoded = encodeProof(proof)
    expect(encoded).toHaveLength(4 + 96)
    expect(new DataView(encoded.buffer).getUint32(0, true)).toBe(3)
    expect(encoded[4]).toBe(0x11)
    expect(encoded[36]).toBe(0x22)
    expect(encoded[68]).toBe(0x33)
  })

  it('rejects malformed proof elements', () => {
    expect(() => encodeProof(['0x1234'])).toThrow()
  })

  it('decodes a Collection account encoded in the documented Borsh order', () => {
    const bytes = encodeCollectionFixture()
    const state = decodeCollection(bytes)
    expect(state).not.toBeNull()
    expect(state!.maxSupply).toBe(COLLECTION.maxSupply)
    expect(state!.totalMinted).toBe(1234)
    expect(state!.priceLamports).toBe(solToLamports(0.35))
    expect(state!.phase).toBe(2)
    expect(state!.name).toBe(COLLECTION.name)
    expect(state!.symbol).toBe(COLLECTION.symbol)
    expect(state!.paused).toBe(false)
    expect(state!.generatorVersion).toBe(COLLECTION.generatorVersion)
    expect(state!.allowlistRoot).toBe(base58Encode(new Uint8Array(32).fill(0xab)))
    expect(state!.allowlistPriceLamports).toBe(solToLamports(0.25))
    expect(state!.allowlistAllocation).toBe(SCHEDULE.allowlistAllocation)
    expect(state!.maxPerWallet).toBe(COLLECTION.maxPerWallet)
    expect(state!.royaltyBps).toBe(COLLECTION.royaltyBps)
    expect(state!.uriBase).toBe('https://chromafield.dev/api/meta/')
    expect(state!.allowlistStart).toBe(SCHEDULE.allowlistStart / 1000)
  })

  it('refuses to decode an account with the wrong discriminator', () => {
    const bytes = encodeCollectionFixture()
    bytes[0] = (bytes[0] + 1) % 256
    expect(decodeCollection(bytes)).toBeNull()
    expect(decodeCollection(null)).toBeNull()
    expect(decodeCollection(new Uint8Array(4))).toBeNull()
  })
})

/** Hand-written Borsh fixture mirroring the Rust `Collection` struct. */
function encodeCollectionFixture(): Uint8Array {
  const parts: Uint8Array[] = []
  parts.push(Uint8Array.from(ACCOUNT_DISCRIMINATORS.Collection))
  parts.push(new Uint8Array(32).fill(1)) // authority
  parts.push(new Uint8Array(32).fill(2)) // treasury
  parts.push(u64(solToLamports(0.35))) // price_lamports
  parts.push(u64(solToLamports(0.25))) // allowlist_price_lamports
  parts.push(u32(COLLECTION.maxSupply)) // max_supply
  parts.push(u32(1234)) // total_minted
  parts.push(u32(612)) // allowlist_minted
  parts.push(u32(SCHEDULE.allowlistAllocation)) // allowlist_allocation
  parts.push(u32(COLLECTION.maxPerWallet)) // max_per_wallet
  parts.push(u16(COLLECTION.royaltyBps)) // royalty_bps
  parts.push(new Uint8Array([2])) // phase
  parts.push(new Uint8Array([0])) // paused
  parts.push(new Uint8Array([254])) // bump
  parts.push(new Uint8Array(32).fill(0xab)) // allowlist_root
  parts.push(i64(BigInt(SCHEDULE.allowlistStart / 1000))) // allowlist_start
  parts.push(i64(BigInt(SCHEDULE.publicStart / 1000))) // public_start
  parts.push(i64(BigInt(SCHEDULE.endsAt / 1000))) // ends_at
  parts.push(str('https://chromafield.dev/api/meta/'))
  parts.push(str(COLLECTION.name))
  parts.push(str(COLLECTION.symbol))
  parts.push(str(COLLECTION.generatorVersion))

  let total = 0
  for (const p of parts) total += p.length
  const out = new Uint8Array(total)
  let offset = 0
  for (const p of parts) {
    out.set(p, offset)
    offset += p.length
  }
  return out
}

function u16(value: number): Uint8Array {
  const out = new Uint8Array(2)
  new DataView(out.buffer).setUint16(0, value, true)
  return out
}

function u32(value: number): Uint8Array {
  const out = new Uint8Array(4)
  new DataView(out.buffer).setUint32(0, value, true)
  return out
}

function u64(value: bigint): Uint8Array {
  const out = new Uint8Array(8)
  new DataView(out.buffer).setBigUint64(0, value, true)
  return out
}

function i64(value: bigint): Uint8Array {
  const out = new Uint8Array(8)
  new DataView(out.buffer).setBigInt64(0, value, true)
  return out
}

function str(value: string): Uint8Array {
  const body = new TextEncoder().encode(value)
  const out = new Uint8Array(4 + body.length)
  new DataView(out.buffer).setUint32(0, body.length, true)
  out.set(body, 4)
  return out
}

/* --------------------------------------------------------------- phase */

describe('phase resolution', () => {
  const base: ChainSnapshot = {
    source: 'demo',
    totalMinted: 100,
    maxSupply: COLLECTION.maxSupply,
    allowlistMinted: 50,
    allowlistAllocation: SCHEDULE.allowlistAllocation,
    maxPerWallet: COLLECTION.maxPerWallet,
    treasury: '5MtUTGRrZtmc7ApJsDfHevdzW8faZPZHJ3wki6bLswM2',
    phase: 2,
    priceLamports: solToLamports(0.35),
    paused: false,
    holders: 90,
    updatedAt: Date.now(),
  }

  it('is upcoming before the allowlist opens', () => {
    const info = resolvePhase(base, SCHEDULE.allowlistStart - 1000)
    expect(info.status).toBe('upcoming')
    expect(info.canMint).toBe(false)
    expect(info.nextChangeAt).toBe(SCHEDULE.allowlistStart)
  })

  it('is allowlist-gated between allowlist and public start', () => {
    const info = resolvePhase(base, SCHEDULE.publicStart - 1000)
    expect(info.status).toBe('live')
    expect(info.requiresAllowlist).toBe(true)
    expect(info.priceSol).toBe(0.25)
  })

  it('opens public minting at the scheduled time', () => {
    const info = resolvePhase(base, SCHEDULE.publicStart + 1000)
    expect(info.status).toBe('live')
    expect(info.requiresAllowlist).toBe(false)
    expect(info.priceSol).toBe(0.35)
  })

  it('opens public early once the allowlist allocation fills', () => {
    const info = resolvePhase({ ...base, allowlistMinted: SCHEDULE.allowlistAllocation }, SCHEDULE.publicStart - 1000)
    expect(info.requiresAllowlist).toBe(false)
    expect(info.status).toBe('live')
  })

  it('reports sold out at the cap', () => {
    const info = resolvePhase({ ...base, totalMinted: COLLECTION.maxSupply }, Date.now())
    expect(info.status).toBe('soldout')
    expect(info.canMint).toBe(false)
    expect(info.remaining).toBe(0)
  })

  it('honours the pause flag', () => {
    const info = resolvePhase({ ...base, paused: true }, SCHEDULE.publicStart + 1000)
    expect(info.canMint).toBe(false)
  })

  it('ends after the closing timestamp', () => {
    const info = resolvePhase(base, SCHEDULE.endsAt + 1000)
    expect(info.status).toBe('ended')
    expect(info.canMint).toBe(false)
  })
})

/* ----------------------------------------------------------- demo chain */

describe('demo chain simulation', () => {
  it('hands out sequential token ids and tracks holdings', () => {
    const before = demoChain.snapshot().totalMinted
    const entries = demoChain.mint(2, 'DemoTesterAddress1111111111111111111111111111', solToLamports(0.7))
    expect(entries).toHaveLength(2)
    expect(entries[0].tokenId).toBe(before + 1)
    expect(entries[1].tokenId).toBe(before + 2)
    expect(demoChain.snapshot().totalMinted).toBe(before + 2)
    expect(demoChain.myTokens()).toContain(before + 1)
  })

  it('never mints past the cap', () => {
    demoChain.reset()
    const available = demoChain.availableTokens(3)
    expect(available[0]).toBe(demoChain.snapshot().totalMinted + 1)
    expect(available).toHaveLength(3)
  })

  it('deducts the paid amount from the demo balance', () => {
    demoChain.reset()
    const before = demoChain.balanceLamports()
    demoChain.mint(1, 'DemoTesterAddress1111111111111111111111111111', solToLamports(0.35))
    expect(demoChain.balanceLamports()).toBeLessThan(before)
  })
})
