/**
 * Chain state.
 *
 * Two sources behind one `ChainSnapshot`:
 *   • `DemoChain`  — a local simulation (persisted in localStorage) that keeps
 *     ticking, mints to your wallet and produces a realistic activity feed.
 *   • `fetchLiveSnapshot` — reads the on-chain `Collection` PDA over RPC.
 *
 * Phase resolution is shared, so the UI behaves identically in both modes.
 */

import { COLLECTION, CONTRACT, NETWORKS, PHASE as PRICE_PHASE, SCHEDULE, type NetworkId } from '@/config'
import { lamportsToSol, solToLamports } from './format'
import { randomBase58 } from './base58'
import {
  addressFromSeed,
  decodeCollection,
  deriveCollectionPda,
  PHASE,
  withWeb3,
  type PhaseValue,
  type Web3,
} from './program'

export interface ChainSnapshot {
  source: 'demo' | 'chain' | 'offline'
  totalMinted: number
  maxSupply: number
  allowlistMinted: number
  /** On-chain in live mode; from SCHEDULE in demo mode. */
  allowlistAllocation: number
  maxPerWallet: number
  treasury: string
  phase: PhaseValue
  priceLamports: bigint
  paused: boolean
  holders: number
  updatedAt: number
  error?: string
}

export interface PhaseInfo {
  phase: PhaseValue
  label: string
  status: 'upcoming' | 'live' | 'ended' | 'soldout'
  priceSol: number
  /** Timestamp the current phase flips at. */
  nextChangeAt: number
  canMint: boolean
  requiresAllowlist: boolean
  remaining: number
}

export interface ActivityEntry {
  id: string
  address: string | null
  tokenId: number | null
  signature: string | null
  at: number
  kind: 'mint' | 'sale' | 'transfer'
}

/* ------------------------------------------------------------ demo chain */

interface DemoPersisted {
  totalMinted: number
  allowlistMinted: number
  holders: number
  myTokens: number[]
  myAddress: string | null
  balanceLamports: number
  activity: ActivityEntry[]
  updatedAt: number
}

const DEMO_KEY = 'chromafield.demo.chain.v1'
const SEED_SUPPLY = 1284
const SEED_ALLOWLIST = 612

function loadPersisted(): DemoPersisted {
  const fallback: DemoPersisted = {
    totalMinted: SEED_SUPPLY,
    allowlistMinted: SEED_ALLOWLIST,
    holders: 903,
    myTokens: [],
    myAddress: null,
    balanceLamports: 8_400_000_000,
    activity: [],
    updatedAt: Date.now(),
  }
  if (typeof localStorage === 'undefined') return fallback
  try {
    const raw = localStorage.getItem(DEMO_KEY)
    if (!raw) return fallback
    const parsed = JSON.parse(raw) as Partial<DemoPersisted>
    return { ...fallback, ...parsed, activity: parsed.activity?.slice(0, 40) ?? [] }
  } catch {
    return fallback
  }
}

/** Deterministic-ish random wallet for feed filler. */
function randomHolder(i: number): string {
  return addressFromSeed(`chromafield/holder/${i}`)
}

export class DemoChain {
  private state: DemoPersisted = loadPersisted()
  private listeners = new Set<() => void>()
  private activitySeq = 0

  constructor() {
    this.catchUp()
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  private emit() {
    this.listeners.forEach((l) => l())
  }

  private persist() {
    this.state.updatedAt = Date.now()
    if (typeof localStorage === 'undefined') return
    try {
      localStorage.setItem(DEMO_KEY, JSON.stringify(this.state))
    } catch {
      /* storage full or unavailable — keep running in memory */
    }
  }

  /** Simulate mints that happened while the tab was closed. */
  private catchUp() {
    const elapsedMin = Math.max(0, (Date.now() - this.state.updatedAt) / 60_000)
    const drift = Math.min(48, Math.round(elapsedMin * 0.6))
    if (drift > 0 && this.state.totalMinted + drift <= COLLECTION.maxSupply) {
      this.state.totalMinted += drift
      this.state.holders += Math.round(drift * 0.7)
      this.persist()
    }
  }

  snapshot(): ChainSnapshot {
    return {
      source: 'demo',
      totalMinted: this.state.totalMinted,
      maxSupply: COLLECTION.maxSupply,
      allowlistMinted: this.state.allowlistMinted,
      allowlistAllocation: SCHEDULE.allowlistAllocation,
      maxPerWallet: COLLECTION.maxPerWallet,
      treasury: CONTRACT.treasury,
      phase: PHASE.public,
      priceLamports: solToLamports(PRICE_PHASE.publicPriceSol),
      paused: false,
      holders: this.state.holders,
      updatedAt: this.state.updatedAt,
    }
  }

  /** Most recent simulated mints, newest first. */
  recentActivity(limit = 14): ActivityEntry[] {
    return this.state.activity.slice(0, limit)
  }

  myTokens(): number[] {
    return [...this.state.myTokens]
  }

  balanceLamports(): number {
    return this.state.balanceLamports
  }

  balanceSol(): number {
    return lamportsToSol(this.state.balanceLamports)
  }

  setMyAddress(address: string | null) {
    if (this.state.myAddress === address) return
    this.state.myAddress = address
    this.persist()
  }

  /** Background noise: someone else mints. Returns the entry if it happened. */
  tick(): ActivityEntry | null {
    if (this.state.totalMinted >= COLLECTION.maxSupply) return null
    if (Math.random() > 0.55) return null
    const entry = this.recordMint(1, randomHolder(this.state.totalMinted + this.activitySeq))
    this.activitySeq += 1
    this.persist()
    this.emit()
    return entry[0] ?? null
  }

  /** True when the simulated supply is exhausted. */
  get soldOut(): boolean {
    return this.state.totalMinted >= COLLECTION.maxSupply
  }

  private recordMint(quantity: number, address: string | null): ActivityEntry[] {
    const entries: ActivityEntry[] = []
    const now = Date.now()
    for (let i = 0; i < quantity; i++) {
      const tokenId = this.state.totalMinted + 1
      this.state.totalMinted = tokenId
      if (this.state.allowlistMinted < SCHEDULE.allowlistAllocation && Date.now() < SCHEDULE.publicStart) {
        this.state.allowlistMinted += 1
      }
      const entry: ActivityEntry = {
        id: `${now}-${tokenId}-${Math.random().toString(36).slice(2, 7)}`,
        address,
        tokenId,
        signature: randomBase58(64, Math.random()),
        at: now + i * 900,
        kind: 'mint',
      }
      entries.push(entry)
      this.state.activity.unshift(entry)
    }
    this.state.activity = this.state.activity.slice(0, 40)
    if (address) this.state.holders += 1
    return entries
  }

  /** A real (simulated) mint by the connected wallet. */
  mint(quantity: number, address: string, costLamports: bigint): ActivityEntry[] {
    const available = COLLECTION.maxSupply - this.state.totalMinted
    const count = Math.max(0, Math.min(quantity, available))
    if (count === 0) return []
    const entries = this.recordMint(count, address)
    this.state.myTokens.push(...entries.map((e) => e.tokenId!).sort((a, b) => a - b))
    this.state.balanceLamports = Math.max(0, this.state.balanceLamports - Number(costLamports))
    this.persist()
    this.emit()
    return entries
  }

  availableTokens(count: number): number[] {
    const start = this.state.totalMinted + 1
    return Array.from({ length: count }, (_, i) => Math.min(start + i, COLLECTION.maxSupply))
  }

  topUp() {
    this.state.balanceLamports += 10_000_000_000
    this.persist()
    this.emit()
  }

  reset() {
    this.state = {
      totalMinted: SEED_SUPPLY,
      allowlistMinted: SEED_ALLOWLIST,
      holders: 903,
      myTokens: [],
      myAddress: null,
      balanceLamports: 8_400_000_000,
      activity: [],
      updatedAt: Date.now(),
    }
    this.persist()
    this.emit()
  }
}

export const demoChain = new DemoChain()

/* ------------------------------------------------------------ live chain */

const connections = new Map<string, unknown>()

async function connectionFor(network: NetworkId, rpcOverride?: string) {
  const web3 = await withWeb3()
  const key = `${network}|${rpcOverride ?? ''}`
  const cached = connections.get(key) as InstanceType<Web3['Connection']> | undefined
  if (cached) return cached
  const endpoint = rpcOverride?.trim() || NETWORKS[network].rpc
  const connection = new web3.Connection(endpoint, 'confirmed')
  connections.set(key, connection)
  return connection
}

export async function fetchLiveSnapshot(
  network: NetworkId,
  programId: string,
  rpcOverride?: string,
): Promise<ChainSnapshot> {
  try {
    const web3 = await withWeb3()
    const connection = await connectionFor(network, rpcOverride)
    const pda = await deriveCollectionPda(programId)
    const info = await connection.getAccountInfo(new web3.PublicKey(pda))
    const state = decodeCollection(info?.data ? new Uint8Array(info.data) : null)
    if (!state) {
      return {
        ...offlineSnapshot(),
        error: `No Collection account at ${pda.slice(0, 8)}… on ${network}. Is the program initialised?`,
      }
    }
    return {
      source: 'chain',
      totalMinted: state.totalMinted,
      maxSupply: state.maxSupply,
      allowlistMinted: state.allowlistMinted,
      allowlistAllocation: state.allowlistAllocation,
      maxPerWallet: state.maxPerWallet,
      treasury: state.treasury,
      phase: state.phase,
      priceLamports: state.priceLamports,
      paused: state.paused,
      holders: state.totalMinted,
      updatedAt: Date.now(),
    }
  } catch (err) {
    return {
      ...offlineSnapshot(),
      error: err instanceof Error ? err.message : 'RPC request failed.',
    }
  }
}

function offlineSnapshot(): ChainSnapshot {
  return {
    source: 'offline',
    totalMinted: 0,
    maxSupply: COLLECTION.maxSupply,
    allowlistMinted: 0,
    allowlistAllocation: SCHEDULE.allowlistAllocation,
    maxPerWallet: COLLECTION.maxPerWallet,
    treasury: CONTRACT.treasury,
    phase: PHASE.notStarted,
    priceLamports: solToLamports(COLLECTION.priceSol),
    paused: false,
    holders: 0,
    updatedAt: Date.now(),
  }
}

export async function fetchBalance(
  address: string,
  network: NetworkId,
  rpcOverride?: string,
): Promise<number | null> {
  try {
    const web3 = await withWeb3()
    const connection = await connectionFor(network, rpcOverride)
    const lamports = await connection.getBalance(new web3.PublicKey(address))
    return lamportsToSol(lamports)
  } catch {
    return null
  }
}

/** Recent program activity, straight from RPC (signatures on the Collection PDA). */
export async function fetchLiveActivity(
  network: NetworkId,
  programId: string,
  limit = 8,
  rpcOverride?: string,
): Promise<ActivityEntry[]> {
  try {
    const web3 = await withWeb3()
    const connection = await connectionFor(network, rpcOverride)
    const pda = await deriveCollectionPda(programId)
    const sigs = await connection.getSignaturesForAddress(new web3.PublicKey(pda), { limit })
    return sigs.map((s, i) => ({
      id: `${s.signature}-${i}`,
      address: null,
      tokenId: null,
      signature: s.signature,
      at: (s.blockTime ?? Date.now() / 1000) * 1000,
      kind: 'mint' as const,
    }))
  } catch {
    return []
  }
}

/* --------------------------------------------------------- phase maths */

export function resolvePhase(snapshot: ChainSnapshot, now = Date.now()): PhaseInfo {
  const remaining = Math.max(0, snapshot.maxSupply - snapshot.totalMinted)
  const allocation = snapshot.allowlistAllocation || SCHEDULE.allowlistAllocation
  const allowlistFull = snapshot.allowlistMinted >= allocation

  if (snapshot.totalMinted >= snapshot.maxSupply) {
    return {
      phase: PHASE.ended,
      label: 'Sold out',
      status: 'soldout',
      priceSol: lamportsToSol(snapshot.priceLamports),
      nextChangeAt: now,
      canMint: false,
      requiresAllowlist: false,
      remaining: 0,
    }
  }
  if (snapshot.paused) {
    return {
      phase: PHASE.notStarted,
      label: 'Paused by the studio',
      status: 'upcoming',
      priceSol: lamportsToSol(snapshot.priceLamports),
      nextChangeAt: now,
      canMint: false,
      requiresAllowlist: false,
      remaining,
    }
  }
  if (now < SCHEDULE.allowlistStart) {
    return {
      phase: PHASE.notStarted,
      label: 'Mint opens soon',
      status: 'upcoming',
      priceSol: lamportsToSol(snapshot.priceLamports),
      nextChangeAt: SCHEDULE.allowlistStart,
      canMint: false,
      requiresAllowlist: false,
      remaining,
    }
  }
  if (now < SCHEDULE.publicStart && !allowlistFull) {
    return {
      phase: PHASE.allowlist,
      label: 'Allowlist live',
      status: 'live',
      priceSol: PRICE_PHASE.allowlistPriceSol,
      nextChangeAt: SCHEDULE.publicStart,
      canMint: true,
      requiresAllowlist: true,
      remaining,
    }
  }
  if (now < SCHEDULE.endsAt) {
    return {
      phase: PHASE.public,
      label: allowlistFull ? 'Public — allowlist filled' : 'Public mint live',
      status: 'live',
      priceSol: lamportsToSol(snapshot.priceLamports),
      nextChangeAt: SCHEDULE.endsAt,
      canMint: true,
      requiresAllowlist: false,
      remaining,
    }
  }
  return {
    phase: PHASE.ended,
    label: 'Mint closed',
    status: 'ended',
    priceSol: lamportsToSol(snapshot.priceLamports),
    nextChangeAt: now,
    canMint: false,
    requiresAllowlist: false,
    remaining,
  }
}
