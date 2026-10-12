/**
 * Wallet layer.
 *
 * Two implementations behind one interface:
 *   • InjectedWallet — Phantom / Solflare / Backpack (anything exposing
 *     `connect`, `signTransaction`, `signMessage` on window).
 *   • DemoWallet — a simulated signer with a persistent fake address, so the
 *     whole mint flow is clickable with no extension and no funds.
 *
 * Injected providers are only looked up in the browser, and nothing here imports
 * @solana/web3.js, so Demo Mode boots even if the Solana chunk fails to load.
 */

import { base58Encode } from './base58'
import { keccak256 } from './merkle'

export type WalletId = 'phantom' | 'solflare' | 'backpack' | 'demo'

export interface WalletMeta {
  id: WalletId
  name: string
  hint: string
  url: string
  accent: string
  installed: boolean
}

export interface WalletSession {
  id: WalletId
  name: string
  address: string
  isDemo: boolean
  /** Raw provider for injected wallets, null for demo. */
  provider: SolanaProviderLike | null
  signTransaction<T>(tx: T): Promise<T>
  signMessage(message: Uint8Array): Promise<string>
  disconnect(): Promise<void>
  /** Injected wallets can be switched/locked out from under us. */
  onChange(handler: (event: WalletEvent) => void): () => void
}

export type WalletEvent =
  | { type: 'disconnect' }
  | { type: 'accountChanged'; address: string | null }
  | { type: 'connect'; address: string }

const DEMO_ADDRESS_KEY = 'chromafield.demo.address.v1'

/* ------------------------------------------------------------- detection */

function providers(): { id: WalletId; provider: SolanaProviderLike | undefined }[] {
  if (typeof window === 'undefined') return []
  return [
    { id: 'phantom', provider: window.solana?.isPhantom ? window.solana : undefined },
    { id: 'solflare', provider: window.solflare?.isSolflare ? window.solflare : window.solflare },
    { id: 'backpack', provider: window.backpack?.isBackpack ? window.backpack : window.backpack },
  ]
}

export function availableWallets(): WalletMeta[] {
  const found = providers()
  const meta: Omit<WalletMeta, 'installed'>[] = [
    {
      id: 'phantom',
      name: 'Phantom',
      hint: 'Most popular Solana wallet',
      url: 'https://phantom.app/',
      accent: 'linear-gradient(135deg,#ab9ff2,#534bb1)',
    },
    {
      id: 'solflare',
      name: 'Solflare',
      hint: 'Hardware + mobile support',
      url: 'https://solflare.com/',
      accent: 'linear-gradient(135deg,#ffc24b,#fc7d28)',
    },
    {
      id: 'backpack',
      name: 'Backpack',
      hint: 'xNFT native',
      url: 'https://backpack.app/',
      accent: 'linear-gradient(135deg,#ff4d6d,#a1274a)',
    },
    {
      id: 'demo',
      name: 'Demo wallet',
      hint: 'Simulated signer — no extension, no funds',
      url: '',
      accent: 'linear-gradient(135deg,#37e7ff,#7c4dff)',
    },
  ]
  return meta.map((m) => {
    const installed =
      m.id === 'demo' ? true : Boolean(found.find((f) => f.id === m.id)?.provider)
    return { ...m, installed }
  })
}

export function hasInjectedWallet(): boolean {
  return providers().some((p) => p.provider)
}

/* ----------------------------------------------------------- demo wallet */

function demoAddress(): string {
  if (typeof localStorage === 'undefined') return generateDemoAddress()
  const existing = localStorage.getItem(DEMO_ADDRESS_KEY)
  if (existing && existing.length >= 32) return existing
  const fresh = generateDemoAddress()
  try {
    localStorage.setItem(DEMO_ADDRESS_KEY, fresh)
  } catch {
    /* private mode — ephemeral address is fine */
  }
  return fresh
}

function generateDemoAddress(): string {
  const bytes = new Uint8Array(32)
  const stamp = `${Date.now()}:${Math.random()}`
  const hash = keccak256(new TextEncoder().encode(stamp))
  // First byte forced non-zero so base58 has no leading '1' padding.
  bytes.set(hash)
  bytes[0] = bytes[0] === 0 ? 7 : bytes[0]
  return base58Encode(bytes)
}

/** Deterministic 64-byte "signature" over a message — demo mode only. */
function demoSign(message: Uint8Array, address: string): string {
  const first = keccak256(concat(new TextEncoder().encode(address), message))
  const second = keccak256(concat(first, new TextEncoder().encode('chromafield-demo-sig')))
  return base58Encode(concat(first, second))
}

function concat(a: Uint8Array, b: Uint8Array): Uint8Array {
  const out = new Uint8Array(a.length + b.length)
  out.set(a, 0)
  out.set(b, a.length)
  return out
}

export interface DemoWalletOptions {
  /** Force the next signature to be rejected — used to exercise error UI. */
  rejectNext?: () => boolean
  /** Simulated round-trip latency in ms. */
  latency?: () => number
}

export async function connectDemoWallet(options: DemoWalletOptions = {}): Promise<WalletSession> {
  const address = demoAddress()
  const latency = options.latency ?? (() => 900 + Math.random() * 700)
  const rejectNext = options.rejectNext ?? (() => false)

  await sleep(520 + Math.random() * 260)

  const listeners = new Set<(event: WalletEvent) => void>()
  return {
    id: 'demo',
    name: 'Demo wallet',
    address,
    isDemo: true,
    provider: null,
    async signTransaction<T>(tx: T): Promise<T> {
      await sleep(latency())
      if (rejectNext()) {
        throw new WalletError('Transaction rejected in demo wallet.', 'rejected')
      }
      return tx
    },
    async signMessage(message: Uint8Array): Promise<string> {
      await sleep(latency() * 0.6)
      if (rejectNext()) {
        throw new WalletError('Message signature rejected in demo wallet.', 'rejected')
      }
      return demoSign(message, address)
    },
    async disconnect() {
      listeners.clear()
    },
    onChange(handler) {
      listeners.add(handler)
      return () => listeners.delete(handler)
    },
  }
}

/* ------------------------------------------------------- injected wallet */

export class WalletError extends Error {
  constructor(
    message: string,
    readonly kind: 'rejected' | 'not-installed' | 'locked' | 'unsupported' | 'unknown' = 'unknown',
  ) {
    super(message)
    this.name = 'WalletError'
  }
}

export async function connectInjectedWallet(id: WalletId): Promise<WalletSession> {
  const entry = providers().find((p) => p.id === id)
  const provider = entry?.provider
  const meta = availableWallets().find((w) => w.id === id)
  if (!provider) {
    throw new WalletError(`${meta?.name ?? 'Wallet'} is not installed.`, 'not-installed')
  }

  let result: { publicKey: { toString(): string } }
  try {
    result = await provider.connect()
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    if (/reject|denied|cancel/i.test(message)) {
      throw new WalletError('Connection request was rejected.', 'rejected')
    }
    throw new WalletError(message || 'Could not connect to wallet.', 'unknown')
  }

  const address = result.publicKey?.toString()
  if (!address) throw new WalletError('Wallet returned no public key.', 'locked')

  const listeners = new Set<(event: WalletEvent) => void>()
  const emit = (event: WalletEvent) => listeners.forEach((l) => l(event))

  const onDisconnect = () => emit({ type: 'disconnect' })
  const onAccountChanged = (payload: unknown) => {
    const pub = payload as { toString?: () => string } | null
    emit({ type: 'accountChanged', address: pub?.toString?.() ?? null })
  }
  provider.on?.('disconnect', onDisconnect)
  provider.on?.('accountChanged', onAccountChanged)

  return {
    id,
    name: meta?.name ?? id,
    address,
    isDemo: false,
    provider,
    async signTransaction<T>(tx: T): Promise<T> {
      if (!provider.signTransaction) {
        throw new WalletError('This wallet cannot sign transactions.', 'unsupported')
      }
      try {
        return await provider.signTransaction(tx)
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err)
        if (/reject|denied|cancel|user/i.test(message)) {
          throw new WalletError('You rejected the transaction in your wallet.', 'rejected')
        }
        throw new WalletError(message || 'Wallet could not sign the transaction.', 'unknown')
      }
    },
    async signMessage(message: Uint8Array): Promise<string> {
      if (!provider.signMessage) {
        throw new WalletError('This wallet cannot sign messages.', 'unsupported')
      }
      try {
        const res = await provider.signMessage(message)
        return base58Encode(res.signature)
      } catch (err) {
        const text = err instanceof Error ? err.message : String(err)
        if (/reject|denied|cancel/i.test(text)) {
          throw new WalletError('You rejected the signature request.', 'rejected')
        }
        throw new WalletError(text || 'Wallet could not sign the message.', 'unknown')
      }
    },
    async disconnect() {
      provider.removeListener?.('disconnect', onDisconnect)
      provider.removeListener?.('accountChanged', onAccountChanged)
      try {
        await provider.disconnect()
      } catch {
        /* ignore */
      }
      listeners.clear()
    },
    onChange(handler) {
      listeners.add(handler)
      return () => {
        listeners.delete(handler)
      }
    },
  }
}

export async function connectWallet(
  id: WalletId,
  demoOptions?: DemoWalletOptions,
): Promise<WalletSession> {
  if (id === 'demo') return connectDemoWallet(demoOptions)
  return connectInjectedWallet(id)
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}
