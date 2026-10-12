/**
 * App state.
 *
 * One provider owns: settings (persisted), the wallet session, the chain
 * snapshot (demo or live), the activity feed, allowlist verification, the mint
 * stage machine and toasts. Components read it through `useApp()`.
 */

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react'
import {
  COLLECTION,
  CONTRACT,
  NETWORKS,
  PHASE as MINT_PRICE,
  SCHEDULE,
  type NetworkId,
} from '@/config'
import { base58Decode } from '@/lib/base58'
import {
  demoChain,
  fetchBalance,
  fetchLiveActivity,
  fetchLiveSnapshot,
  resolvePhase,
  type ActivityEntry,
  type ChainSnapshot,
} from '@/lib/chain'
import { solToLamports } from '@/lib/format'
import { demoAllowlist, MerkleTree, toHex } from '@/lib/merkle'
import { MintAbortedError, mintTokens, type MintAttempt, type MintReceipt } from '@/lib/mint'
import { decodeCollection, deriveCollectionPda, validateProgramId } from '@/lib/program'
import {
  availableWallets,
  connectWallet,
  WalletError,
  type WalletId,
  type WalletSession,
} from '@/lib/wallet'

export type Mode = 'demo' | 'live'

export interface Settings {
  mode: Mode
  network: NetworkId
  programId: string
  rpcUrl: string
  /** Demo-only: force the next wallet signature to be rejected. */
  simulateRejection: boolean
  /** Demo-only: pretend the wallet holds almost no SOL. */
  simulateEmptyWallet: boolean
}

export interface Toast {
  id: string
  tone: 'success' | 'error' | 'info'
  title: string
  body?: string
}

export interface AllowlistState {
  rootHex: string
  proof: string[]
  included: boolean
  checking: boolean
  error: string | null
  source: 'demo' | 'chain' | 'manual'
}

interface AppValue {
  settings: Settings
  updateSettings: (patch: Partial<Settings>) => void
  resetSettings: () => void
  resetDemo: () => void

  wallets: ReturnType<typeof availableWallets>
  wallet: WalletSession | null
  connecting: WalletId | null
  connect: (id: WalletId) => Promise<void>
  disconnect: () => Promise<void>
  balanceSol: number | null
  refreshBalance: () => Promise<void>
  topUpDemo: () => void

  snapshot: ChainSnapshot
  phase: ReturnType<typeof resolvePhase>
  refreshing: boolean
  refresh: () => Promise<void>
  activity: ActivityEntry[]
  myTokens: number[]

  allowlist: AllowlistState
  verifyAllowlist: (manualProof?: string[]) => Promise<void>
  allowlistTree: MerkleTree | null

  attempt: MintAttempt | null
  minting: boolean
  receipt: MintReceipt | null
  startMint: (quantity: number) => Promise<void>
  cancelMint: () => void
  dismissReceipt: () => void

  toasts: Toast[]
  pushToast: (toast: Omit<Toast, 'id'>) => void
  dismissToast: (id: string) => void
}

const SETTINGS_KEY = 'chromafield.settings.v1'

const DEFAULT_SETTINGS: Settings = {
  mode: 'demo',
  network: 'devnet',
  programId: CONTRACT.programId === 'demo' ? '' : CONTRACT.programId,
  rpcUrl: '',
  simulateRejection: false,
  simulateEmptyWallet: false,
}

function loadSettings(): Settings {
  if (typeof localStorage === 'undefined') return DEFAULT_SETTINGS
  try {
    const raw = localStorage.getItem(SETTINGS_KEY)
    if (!raw) return DEFAULT_SETTINGS
    const parsed = JSON.parse(raw) as Partial<Settings>
    return {
      ...DEFAULT_SETTINGS,
      ...parsed,
      network: (parsed.network ?? 'devnet') as NetworkId,
      mode: parsed.mode === 'live' ? 'live' : 'demo',
    }
  } catch {
    return DEFAULT_SETTINGS
  }
}

const AppContext = createContext<AppValue | null>(null)

export function useApp(): AppValue {
  const value = useContext(AppContext)
  if (!value) throw new Error('useApp must be used inside <AppProvider>')
  return value
}

function emptySnapshot(source: ChainSnapshot['source'] = 'demo', error?: string): ChainSnapshot {
  return {
    source,
    totalMinted: 0,
    maxSupply: COLLECTION.maxSupply,
    allowlistMinted: 0,
    allowlistAllocation: SCHEDULE.allowlistAllocation,
    maxPerWallet: COLLECTION.maxPerWallet,
    treasury: CONTRACT.treasury,
    phase: 0,
    priceLamports: solToLamports(COLLECTION.priceSol),
    paused: false,
    holders: 0,
    updatedAt: Date.now(),
    error,
  }
}

export function AppProvider({ children }: { children: ReactNode }) {
  const [settings, setSettings] = useState<Settings>(loadSettings)
  const [wallet, setWallet] = useState<WalletSession | null>(null)
  const [connecting, setConnecting] = useState<WalletId | null>(null)
  const [balanceSol, setBalanceSol] = useState<number | null>(null)
  const [snapshot, setSnapshot] = useState<ChainSnapshot>(() =>
    settings.mode === 'demo' ? demoChain.snapshot() : emptySnapshot('offline'),
  )
  const [refreshing, setRefreshing] = useState(false)
  const [activity, setActivity] = useState<ActivityEntry[]>(() => demoChain.recentActivity(14))
  const [myTokens, setMyTokens] = useState<number[]>(() => demoChain.myTokens())
  const [attempt, setAttempt] = useState<MintAttempt | null>(null)
  const [minting, setMinting] = useState(false)
  const [receipt, setReceipt] = useState<MintReceipt | null>(null)
  const [toasts, setToasts] = useState<Toast[]>([])
  const [allowlistTree, setAllowlistTree] = useState<MerkleTree | null>(null)
  const [allowlist, setAllowlist] = useState<AllowlistState>({
    rootHex: '',
    proof: [],
    included: false,
    checking: false,
    error: null,
    source: 'demo',
  })
  /** Re-resolves phase boundaries without re-rendering every second. */
  const [clock, setClock] = useState(() => Date.now())
  /** Address that has actually passed the Merkle/signature check. */
  const [verifiedAddress, setVerifiedAddress] = useState<string | null>(null)

  const abortRef = useRef<AbortController | null>(null)
  const rejectionRef = useRef(settings.simulateRejection)
  rejectionRef.current = settings.simulateRejection

  useEffect(() => {
    const id = window.setInterval(() => setClock(Date.now()), 15_000)
    return () => window.clearInterval(id)
  }, [])

  const phase = useMemo(() => resolvePhase(snapshot, clock), [snapshot, clock])

  /* ------------------------------------------------------------ settings */

  const updateSettings = useCallback((patch: Partial<Settings>) => {
    setSettings((prev) => {
      const next = { ...prev, ...patch }
      try {
        localStorage.setItem(SETTINGS_KEY, JSON.stringify(next))
      } catch {
        /* ignore */
      }
      return next
    })
  }, [])

  const resetSettings = useCallback(() => {
    setSettings(DEFAULT_SETTINGS)
    try {
      localStorage.removeItem(SETTINGS_KEY)
    } catch {
      /* ignore */
    }
  }, [])

  const resetDemo = useCallback(() => {
    demoChain.reset()
    setSnapshot(demoChain.snapshot())
    setActivity([])
    setMyTokens([])
    setReceipt(null)
    setAttempt(null)
    setBalanceSol(demoChain.balanceSol())
  }, [])

  /* -------------------------------------------------------------- toasts */

  const dismissToast = useCallback((id: string) => {
    setToasts((prev) => prev.filter((t) => t.id !== id))
  }, [])

  const pushToast = useCallback(
    (toast: Omit<Toast, 'id'>) => {
      const id = `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`
      setToasts((prev) => [...prev.slice(-3), { ...toast, id }])
      window.setTimeout(() => dismissToast(id), toast.tone === 'error' ? 9000 : 5200)
    },
    [dismissToast],
  )

  /* -------------------------------------------------------------- wallet */

  const refreshBalance = useCallback(async () => {
    if (!wallet) {
      setBalanceSol(null)
      return
    }
    if (wallet.isDemo || settings.mode === 'demo') {
      setBalanceSol(settings.simulateEmptyWallet ? 0.0004 : demoChain.balanceSol())
      return
    }
    const live = await fetchBalance(wallet.address, settings.network, settings.rpcUrl)
    setBalanceSol(live)
  }, [wallet, settings.mode, settings.network, settings.rpcUrl, settings.simulateEmptyWallet])

  const topUpDemo = useCallback(() => {
    demoChain.topUp()
    setBalanceSol(demoChain.balanceSol())
    pushToast({ tone: 'info', title: 'Demo balance topped up', body: '+10 SOL (simulated)' })
  }, [pushToast])

  const connect = useCallback(
    async (id: WalletId) => {
      setConnecting(id)
      try {
        const session = await connectWallet(id, {
          rejectNext: () => rejectionRef.current,
        })
        setWallet(session)
        demoChain.setMyAddress(session.isDemo ? session.address : null)
        pushToast({
          tone: 'success',
          title: `${session.name} connected`,
          body: session.isDemo
            ? 'Simulated signer — nothing leaves the browser.'
            : `${session.address.slice(0, 4)}…${session.address.slice(-4)}`,
        })
        session.onChange((event) => {
          if (event.type === 'disconnect') {
            setWallet(null)
            setBalanceSol(null)
          }
          if (event.type === 'accountChanged' && event.address) {
            setWallet((prev) => (prev ? { ...prev, address: event.address! } : prev))
          }
        })
      } catch (err) {
        const message =
          err instanceof WalletError ? err.message : 'Could not connect to that wallet.'
        pushToast({ tone: 'error', title: 'Connection failed', body: message })
      } finally {
        setConnecting(null)
      }
    },
    [pushToast],
  )

  const disconnect = useCallback(async () => {
    await wallet?.disconnect()
    setWallet(null)
    setBalanceSol(null)
    setVerifiedAddress(null)
    setAllowlist((prev) => ({ ...prev, included: false, proof: [], error: null }))
  }, [wallet])

  // Silent reconnect for a previously-approved injected wallet in live mode.
  useEffect(() => {
    if (settings.mode !== 'live') return
    const installed = availableWallets().filter((w) => w.installed && w.id !== 'demo')
    if (installed.length !== 1) return
    const id = installed[0].id
    const provider = id === 'phantom' ? window.solana : id === 'solflare' ? window.solflare : window.backpack
    if (!provider?.connect) return
    let cancelled = false
    provider
      .connect({ onlyIfTrusted: true })
      .then((res) => {
        if (cancelled || !res?.publicKey) return
        void connect(id)
      })
      .catch(() => undefined)
    return () => {
      cancelled = true
    }
  }, [settings.mode, connect])

  useEffect(() => {
    void refreshBalance()
  }, [refreshBalance, wallet?.address, snapshot.totalMinted])

  /* ---------------------------------------------------------- chain data */

  const refresh = useCallback(async () => {
    if (settings.mode === 'demo') {
      setSnapshot(demoChain.snapshot())
      setMyTokens(demoChain.myTokens())
      return
    }
    setRefreshing(true)
    try {
      const programId = settings.programId.trim()
      const invalid = validateProgramId(programId)
      if (invalid) {
        setSnapshot(emptySnapshot('offline', invalid))
        return
      }
      const [next, recent] = await Promise.all([
        fetchLiveSnapshot(settings.network, programId, settings.rpcUrl),
        fetchLiveActivity(settings.network, programId, 8, settings.rpcUrl),
      ])
      setSnapshot(next)
      if (recent.length > 0) setActivity(recent)
    } finally {
      setRefreshing(false)
    }
  }, [settings.mode, settings.network, settings.programId, settings.rpcUrl])

  // Demo mode: subscribe to the simulated chain and drive the activity ticker.
  useEffect(() => {
    if (settings.mode !== 'demo') return
    setSnapshot(demoChain.snapshot())
    setMyTokens(demoChain.myTokens())
    setActivity(demoChain.recentActivity(14))
    const unsubscribe = demoChain.subscribe(() => {
      setSnapshot(demoChain.snapshot())
      setMyTokens(demoChain.myTokens())
    })
    let timer = window.setTimeout(function schedule() {
      const entry = demoChain.tick()
      if (entry) setActivity((prev) => [entry, ...prev].slice(0, 14))
      timer = window.setTimeout(schedule, 5200 + Math.random() * 7000)
    }, 2600)
    return () => {
      unsubscribe()
      window.clearTimeout(timer)
    }
  }, [settings.mode])

  useEffect(() => {
    void refresh()
    if (settings.mode !== 'live') return
    const id = window.setInterval(() => void refresh(), 30_000)
    return () => window.clearInterval(id)
  }, [refresh, settings.mode])

  /* ----------------------------------------------------------- allowlist */

  useEffect(() => {
    if (settings.mode !== 'demo') {
      setAllowlistTree(null)
      setAllowlist((prev) => ({ ...prev, source: 'chain', included: false, proof: [] }))
      return
    }
    const tree = demoAllowlist(wallet?.address ?? null, SCHEDULE.allowlistAllocation)
    setAllowlistTree(tree)
    setAllowlist((prev) => ({
      ...prev,
      source: 'demo',
      rootHex: tree.rootHex,
      // Stays false until the visitor actually signs and the proof is checked,
      // so the allowlist gate is genuinely demonstrated in Demo Mode.
      included: wallet !== null && verifiedAddress === wallet.address,
      proof: wallet ? tree.proofForAddress(wallet.address) : [],
      error: null,
    }))
  }, [settings.mode, wallet?.address, verifiedAddress])

  const verifyAllowlist = useCallback(
    async (manualProof?: string[]) => {
      if (!wallet) {
        setAllowlist((prev) => ({ ...prev, error: 'Connect a wallet first.' }))
        pushToast({ tone: 'error', title: 'Connect a wallet', body: 'Allowlist checks need an address.' })
        return
      }
      setAllowlist((prev) => ({ ...prev, checking: true, error: null }))
      try {
        if (settings.mode === 'demo' && allowlistTree) {
          // Sign a challenge so the flow mirrors the real allowlist gate.
          const challenge = new TextEncoder().encode(
            `chromafield.dev wants you to sign in with your Solana account:\n${wallet.address}\n${COLLECTION.symbol} allowlist\nURI: https://chromafield.dev`,
          )
          await wallet.signMessage(challenge)
          const proof = allowlistTree.proofForAddress(wallet.address)
          const ok = proof.length > 0 && MerkleTree.verify(wallet.address, proof, allowlistTree.rootHex)
          setVerifiedAddress(ok ? wallet.address : null)
          setAllowlist((prev) => ({
            ...prev,
            checking: false,
            included: ok,
            proof,
            rootHex: allowlistTree.rootHex,
            source: 'demo',
            error: ok ? null : 'This address is not in the demo allowlist.',
          }))
          pushToast(
            ok
              ? {
                  tone: 'success',
                  title: 'Allowlist spot verified',
                  body: `${proof.length}-step Merkle proof matched the root.`,
                }
              : { tone: 'error', title: 'Not allowlisted', body: 'Wait for the public phase.' },
          )
          return
        }

        // Live: read the root from the chain, then verify the supplied proof.
        const programId = settings.programId.trim()
        const pda = await deriveCollectionPda(programId)
        const web3 = await import('@solana/web3.js')
        const connection = new web3.Connection(
          settings.rpcUrl.trim() || NETWORKS[settings.network].rpc,
          'confirmed',
        )
        const info = await connection.getAccountInfo(new web3.PublicKey(pda))
        const state = decodeCollection(info?.data ? new Uint8Array(info.data) : null)
        if (!state) {
          setAllowlist((prev) => ({
            ...prev,
            checking: false,
            error: 'Collection account not found — check the program ID and network.',
          }))
          return
        }
        const rootHex = toHex(base58Decode(state.allowlistRoot))
        const proof = manualProof ?? []
        const ok = proof.length > 0 && MerkleTree.verify(wallet.address, proof, rootHex)
        setAllowlist({
          rootHex,
          proof,
          included: ok,
          checking: false,
          error: ok ? null : 'Proof does not match the on-chain root.',
          source: 'chain',
        })
        pushToast(
          ok
            ? { tone: 'success', title: 'On-chain allowlist verified' }
            : { tone: 'error', title: 'Not allowlisted', body: 'Paste the proof issued with your spot.' },
        )
      } catch (err) {
        const message =
          err instanceof WalletError
            ? err.message
            : err instanceof Error
              ? err.message
              : 'Verification failed.'
        setAllowlist((prev) => ({ ...prev, checking: false, error: message }))
        if (err instanceof WalletError && err.kind === 'rejected') {
          pushToast({ tone: 'error', title: 'Signature rejected', body: message })
        }
      }
    },
    [wallet, settings, allowlistTree, pushToast],
  )

  /* ---------------------------------------------------------------- mint */

  const cancelMint = useCallback(() => {
    abortRef.current?.abort()
  }, [])

  const startMint = useCallback(
    async (quantity: number) => {
      if (!wallet || minting) return
      const count = Math.max(1, Math.min(quantity, COLLECTION.maxPerWallet, phase.remaining))
      if (count === 0) return
      const controller = new AbortController()
      abortRef.current = controller
      setMinting(true)
      setReceipt(null)
      setAttempt({
        stage: 'preflight',
        index: 1,
        total: count,
        message: 'Starting…',
        progress: 0,
      })

      const isDemo = wallet.isDemo || settings.mode === 'demo'
      const usingAllowlistPrice = phase.requiresAllowlist && allowlist.included
      const priceSol = usingAllowlistPrice
        ? MINT_PRICE.allowlistPriceSol
        : phase.priceSol || COLLECTION.priceSol

      try {
        const result = await mintTokens({
          quantity: count,
          address: wallet.address,
          isDemo,
          network: settings.network,
          programId: settings.mode === 'live' ? settings.programId.trim() : CONTRACT.programId,
          rpcUrl: settings.rpcUrl,
          priceSol,
          requiresAllowlist: phase.requiresAllowlist && allowlist.included,
          proof: allowlist.proof,
          signTransaction: <T,>(tx: T) => wallet.signTransaction(tx),
          signal: controller.signal,
          onStage: (next) => setAttempt(next),
        })
        setReceipt(result)
        pushToast({
          tone: 'success',
          title:
            result.tokenIds.length === 1
              ? `Minted #${String(result.tokenIds[0]).padStart(4, '0')}`
              : `Minted ${result.tokenIds.length} tokens`,
          body: result.demo ? 'Simulated — nothing was broadcast.' : 'Confirmed on-chain.',
        })
        if (result.demo) {
          setSnapshot(demoChain.snapshot())
          setMyTokens(demoChain.myTokens())
          setActivity(demoChain.recentActivity(14))
          setBalanceSol(settings.simulateEmptyWallet ? 0.0004 : demoChain.balanceSol())
        } else {
          void refresh()
          void refreshBalance()
        }
      } catch (err) {
        if (!(err instanceof MintAbortedError)) {
          pushToast({
            tone: 'error',
            title: 'Mint failed',
            body: err instanceof Error ? err.message : 'Unknown error.',
          })
        }
      } finally {
        setMinting(false)
        abortRef.current = null
      }
    },
    [
      wallet,
      minting,
      phase,
      settings,
      allowlist.included,
      allowlist.proof,
      pushToast,
      refresh,
      refreshBalance,
    ],
  )

  const dismissReceipt = useCallback(() => setReceipt(null), [])

  /* ------------------------------------------------------------- derived */

  const wallets = useMemo(() => availableWallets(), [settings.mode, clock])

  const value: AppValue = {
    settings,
    updateSettings,
    resetSettings,
    resetDemo,
    wallets,
    wallet,
    connecting,
    connect,
    disconnect,
    balanceSol,
    refreshBalance,
    topUpDemo,
    snapshot,
    phase,
    refreshing,
    refresh,
    activity,
    myTokens,
    allowlist,
    verifyAllowlist,
    allowlistTree,
    attempt,
    minting,
    receipt,
    startMint,
    cancelMint,
    dismissReceipt,
    toasts,
    pushToast,
    dismissToast,
  }

  return <AppContext.Provider value={value}>{children}</AppContext.Provider>
}
