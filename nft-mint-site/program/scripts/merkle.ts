/**
 * Allowlist tooling.
 *
 * Builds the Merkle root the program stores and the per-address proofs the dApp
 * submits. Scheme (must match `programs/chromafield-mint/src/merkle.rs`):
 *
 *   leaf  = keccak256(base58_decode(address))
 *   inner = keccak256(min(a, b) || max(a, b))   // lexicographic byte compare
 *
 * Usage:
 *   npx ts-node scripts/merkle.ts allowlist.txt
 *   npx ts-node scripts/merkle.ts allowlist.txt --out proofs.json
 *
 * `allowlist.txt` is one Solana address per line (# comments allowed).
 */

import { writeFileSync } from 'node:fs'
import { keccak_256 } from '@noble/hashes/sha3'
import { readFileSync } from 'node:fs'
import bs58 from 'bs58'

export const keccak256 = (bytes: Uint8Array): Uint8Array => keccak_256(bytes)

export const leafForAddress = (address: string): Uint8Array => keccak256(bs58.decode(address))

function compareBytes(a: Uint8Array, b: Uint8Array): number {
  const len = Math.min(a.length, b.length)
  for (let i = 0; i < len; i++) if (a[i] !== b[i]) return a[i] - b[i]
  return a.length - b.length
}

export function hashPair(a: Uint8Array, b: Uint8Array): Uint8Array {
  const [first, second] = compareBytes(a, b) <= 0 ? [a, b] : [b, a]
  const joined = new Uint8Array(first.length + second.length)
  joined.set(first)
  joined.set(second, first.length)
  return keccak256(joined)
}

const hex = (b: Uint8Array) => Buffer.from(b).toString('hex')

export class MerkleTree {
  readonly leaves: Uint8Array[]
  private readonly layers: Uint8Array[][]

  constructor(addresses: string[]) {
    if (addresses.length === 0) throw new Error('Empty allowlist')
    this.leaves = addresses.map(leafForAddress)
    this.layers = [this.leaves]
    let layer = this.leaves
    while (layer.length > 1) {
      const next: Uint8Array[] = []
      for (let i = 0; i < layer.length; i += 2) {
        next.push(i + 1 === layer.length ? layer[i] : hashPair(layer[i], layer[i + 1]))
      }
      this.layers.push(next)
      layer = next
    }
  }

  get root(): Uint8Array {
    return this.layers[this.layers.length - 1][0]
  }

  get rootHex(): string {
    return hex(this.root)
  }

  proof(index: number): string[] {
    const proof: string[] = []
    let i = index
    for (let layer = 0; layer < this.layers.length - 1; layer++) {
      const nodes = this.layers[layer]
      const sibling = i % 2 === 1 ? nodes[i - 1] : nodes[i + 1]
      if (sibling) proof.push(hex(sibling))
      i = Math.floor(i / 2)
    }
    return proof
  }

  verify(address: string, proofHex: string[]): boolean {
    let node = leafForAddress(address)
    for (const step of proofHex) {
      node = hashPair(node, Buffer.from(step, 'hex'))
    }
    return hex(node) === this.rootHex
  }
}

function readAddresses(file: string): string[] {
  return readFileSync(file, 'utf8')
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && !line.startsWith('#'))
}

async function main() {
  const [file, ...rest] = process.argv.slice(2)
  if (!file) {
    console.error('usage: ts-node scripts/merkle.ts <allowlist.txt> [--out proofs.json]')
    process.exit(1)
  }
  const addresses = readAddresses(file)
  const tree = new MerkleTree(addresses)

  const proofs = Object.fromEntries(
    addresses.map((address, index) => [address, { index, proof: tree.proof(index) }]),
  )

  const outIndex = rest.indexOf('--out')
  const outFile = outIndex >= 0 ? rest[outIndex + 1] : 'allowlist-proofs.json'
  writeFileSync(
    outFile,
    JSON.stringify(
      {
        root: tree.rootHex,
        rootBase58: bs58.encode(tree.root),
        count: addresses.length,
        scheme: 'keccak256 sorted-pair, leaf = keccak256(pubkey bytes)',
        proofs,
      },
      null,
      2,
    ),
  )

  console.log(`addresses : ${addresses.length}`)
  console.log(`root hex  : ${tree.rootHex}`)
  console.log(`root b58  : ${bs58.encode(tree.root)}`)
  console.log(`written   : ${outFile}`)

  // Self-check every proof before shipping the root on-chain.
  for (const [address, entry] of Object.entries(proofs) as [string, { index: number; proof: string[] }][]) {
    if (!tree.verify(address, entry.proof)) throw new Error(`Proof failed self-check for ${address}`)
  }
  console.log('self-check: all proofs verified')
}

if (require.main === module) {
  main().catch((err) => {
    console.error(err)
    process.exit(1)
  })
}
