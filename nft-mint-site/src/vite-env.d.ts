/// <reference types="vite/client" />

/** Phantom injects this on window. */
interface SolanaProviderLike {
  isPhantom?: boolean
  isSolflare?: boolean
  isBackpack?: boolean
  publicKey?: { toString(): string; toBytes(): Uint8Array } | null
  connect(opts?: { onlyIfTrusted?: boolean }): Promise<{ publicKey: { toString(): string } }>
  disconnect(): Promise<void>
  signTransaction<T>(tx: T): Promise<T>
  signAllTransactions?<T>(txs: T[]): Promise<T[]>
  signAndSendTransaction?<T>(tx: T): Promise<{ signature: string }>
  signMessage?(message: Uint8Array): Promise<{ signature: Uint8Array; publicKey?: unknown }>
  on?(event: string, handler: (...args: unknown[]) => void): void
  removeListener?(event: string, handler: (...args: unknown[]) => void): void
  request?(args: { method: string; params?: unknown }): Promise<unknown>
}

interface Window {
  solana?: SolanaProviderLike
  solflare?: SolanaProviderLike
  backpack?: SolanaProviderLike
}
