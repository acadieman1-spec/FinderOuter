/**
 * Merkle allowlist.
 *
 * Sorted-pair keccak256 hashing — the same scheme the Rust program verifies, so
 * a proof produced here is accepted on-chain unchanged. Leaves are
 * `keccak256(pubkey_bytes)`, which keeps the on-chain comparison constant-time
 * and avoids putting raw addresses in the tree.
 */

import { keccak_256 } from '@noble/hashes/sha3.js'
import { base58Decode } from './base58'
import { addressFromSeed } from './program'

export function keccak256(bytes: Uint8Array): Uint8Array {
  return keccak_256(bytes)
}

export function leafForAddress(address: string): Uint8Array {
  return keccak256(base58Decode(address))
}

function compareBytes(a: Uint8Array, b: Uint8Array): number {
  const len = Math.min(a.length, b.length)
  for (let i = 0; i < len; i++) {
    if (a[i] !== b[i]) return a[i] - b[i]
  }
  return a.length - b.length
}

/** Sorted-pair hash — order-independent, so proofs verify regardless of side. */
export function hashPair(a: Uint8Array, b: Uint8Array): Uint8Array {
  const [first, second] = compareBytes(a, b) <= 0 ? [a, b] : [b, a]
  const combined = new Uint8Array(first.length + second.length)
  combined.set(first, 0)
  combined.set(second, first.length)
  return keccak256(combined)
}

export function toHex(bytes: Uint8Array): string {
  return Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('')
}

export function fromHex(hex: string): Uint8Array {
  const clean = hex.replace(/^0x/, '')
  const out = new Uint8Array(clean.length / 2)
  for (let i = 0; i < out.length; i++) out[i] = parseInt(clean.slice(i * 2, i * 2 + 2), 16)
  return out
}

export class MerkleTree {
  readonly leaves: Uint8Array[]
  private readonly layers: Uint8Array[][]

  constructor(addresses: readonly string[]) {
    this.leaves = addresses.map(leafForAddress)
    this.layers = [this.leaves]
    let current = this.leaves
    while (current.length > 1) {
      const next: Uint8Array[] = []
      for (let i = 0; i < current.length; i += 2) {
        if (i + 1 === current.length) next.push(current[i])
        else next.push(hashPair(current[i], current[i + 1]))
      }
      this.layers.push(next)
      current = next
    }
  }

  get root(): Uint8Array {
    return this.layers[this.layers.length - 1][0] ?? new Uint8Array(32)
  }

  get rootHex(): string {
    return toHex(this.root)
  }

  get depth(): number {
    return this.layers.length - 1
  }

  indexOfAddress(address: string): number {
    const leaf = toHex(leafForAddress(address))
    return this.leaves.findIndex((l) => toHex(l) === leaf)
  }

  /** Proof as hex strings, root-first ordering excluded (leaf → root). */
  proofForAddress(address: string): string[] {
    const index = this.indexOfAddress(address)
    if (index < 0) return []
    return this.proofForIndex(index)
  }

  proofForIndex(index: number): string[] {
    if (index < 0 || index >= this.leaves.length) return []
    const proof: string[] = []
    let i = index
    for (let layer = 0; layer < this.layers.length - 1; layer++) {
      const nodes = this.layers[layer]
      const isRight = i % 2 === 1
      const sibling = isRight ? nodes[i - 1] : nodes[i + 1]
      if (sibling) proof.push(toHex(sibling))
      i = Math.floor(i / 2)
    }
    return proof
  }

  static verify(address: string, proofHex: readonly string[], rootHex: string): boolean {
    let node = leafForAddress(address)
    for (const step of proofHex) node = hashPair(node, fromHex(step))
    return toHex(node) === rootHex.replace(/^0x/, '')
  }
}

/**
 * Demo allowlist: `size` addresses generated deterministically, with the
 * visitor's own wallet slotted in at index 0 so the allowlist path is actually
 * exercisable without a published list. Live mode reads the real root from the
 * on-chain Collection account instead.
 */
export function demoAllowlist(ownAddress: string | null, size = 768): MerkleTree {
  const addresses: string[] = []
  if (ownAddress) addresses.push(ownAddress)
  for (let i = addresses.length; i < size; i++) {
    addresses.push(addressFromSeed(`chromafield/allowlist/v1/${i}`))
  }
  return new MerkleTree(addresses)
}
