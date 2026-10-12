/**
 * Minimal base58 codec (Bitcoin alphabet — the one Solana uses).
 *
 * Hand-rolled so the demo path can format addresses and signatures without
 * pulling @solana/web3.js into the initial bundle. Handles leading zeros.
 */

const ALPHABET = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz'
const BASE = BigInt(58)

export function base58Encode(bytes: Uint8Array): string {
  let value = 0n
  for (const byte of bytes) value = value * 256n + BigInt(byte)

  let out = ''
  while (value > 0n) {
    const mod = Number(value % BASE)
    out = ALPHABET[mod] + out
    value /= BASE
  }
  for (const byte of bytes) {
    if (byte !== 0) break
    out = ALPHABET[0] + out
  }
  return out || ALPHABET[0]
}

export function base58Decode(text: string): Uint8Array {
  let value = 0n
  for (const char of text) {
    const idx = ALPHABET.indexOf(char)
    if (idx < 0) throw new Error(`Invalid base58 character: ${char}`)
    value = value * BASE + BigInt(idx)
  }
  const bytes: number[] = []
  while (value > 0n) {
    bytes.unshift(Number(value % 256n))
    value /= 256n
  }
  for (const char of text) {
    if (char !== ALPHABET[0]) break
    bytes.unshift(0)
  }
  return Uint8Array.from(bytes)
}

export function isBase58(text: string): boolean {
  return text.length > 0 && /^[123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz]+$/.test(text)
}

/** True when a string looks like a Solana public key (32 bytes, base58). */
export function looksLikePublicKey(text: string): boolean {
  if (!isBase58(text) || text.length < 32 || text.length > 44) return false
  try {
    return base58Decode(text).length === 32
  } catch {
    return false
  }
}

/** Random 32 bytes as base58 — simulated signatures / blockhashes in demo mode. */
export function randomBase58(length = 64, seed = Math.random()): string {
  const bytes = new Uint8Array(length)
  let s = Math.floor(seed * 0xffffffff) >>> 0
  for (let i = 0; i < length; i++) {
    s = (s * 1664525 + 1013904223) >>> 0
    bytes[i] = (s >>> 16) & 0xff
  }
  return base58Encode(bytes)
}
