/**
 * Mint orchestration.
 *
 * `mintTokens()` walks a batch through the same visible stages in both modes:
 *
 *   preflight → building → awaiting-signature → submitting → confirming → complete
 *
 * Live mode really does it: generate a mint keypair, derive the PDAs, build the
 * instruction the Rust program expects, partial-sign with the fresh keypair,
 * hand the transaction to the wallet, broadcast and confirm.
 *
 * Demo mode replays the same stage machine against `DemoChain` with realistic
 * latency and a deterministic fake signature, so the UI can be exercised end to
 * end without an extension or funds.
 */

import { Buffer } from 'buffer'
import { COLLECTION, NETWORKS, CONTRACT, type NetworkId } from '@/config'
import { base58Encode } from './base58'
import { demoChain, fetchBalance, fetchLiveSnapshot, type ChainSnapshot } from './chain'
import { formatSol, solToLamports } from './format'
import { keccak256 } from './merkle'
import {
  ATA_ACCOUNT_ORDER,
  deriveAta,
  deriveCollectionPda,
  deriveMasterEditionPda,
  deriveMetadataPda,
  deriveMintStatePda,
  deriveWalletStatePda,
  encodeCreateAtaIdempotent,
  encodeMintNftData,
  explorerUrl,
  MINT_ACCOUNT_SPACE,
  rentExemptLamports,
  withWeb3,
  type Web3,
} from './program'
import { sleep, WalletError } from './wallet'

type Transaction = InstanceType<Web3['Transaction']>

export type MintStage =
  | 'idle'
  | 'preflight'
  | 'building'
  | 'awaiting-signature'
  | 'submitting'
  | 'confirming'
  | 'complete'
  | 'error'
  | 'cancelled'

export const STAGE_LABEL: Record<MintStage, string> = {
  idle: 'Ready',
  preflight: 'Pre-flight checks',
  building: 'Building transaction',
  'awaiting-signature': 'Approve in wallet',
  submitting: 'Broadcasting',
  confirming: 'Confirming on-chain',
  complete: 'Minted',
  error: 'Failed',
  cancelled: 'Cancelled',
}

export const STAGE_ORDER: MintStage[] = [
  'preflight',
  'building',
  'awaiting-signature',
  'submitting',
  'confirming',
  'complete',
]

export interface MintAttempt {
  stage: MintStage
  /** 1-based index of the token inside this batch. */
  index: number
  total: number
  message: string
  /** 0..1 across the whole batch. */
  progress: number
  tokenId?: number
  signature?: string
  explorerUrl?: string
  slot?: number
  error?: MintFailure
  detail?: Record<string, string>
}

export interface MintFailure {
  kind:
    | 'rejected'
    | 'insufficient-funds'
    | 'sold-out'
    | 'not-allowlisted'
    | 'program'
    | 'network'
    | 'wallet'
    | 'unknown'
  message: string
  hint?: string
  code?: number
}

export interface MintRequest {
  quantity: number
  address: string
  isDemo: boolean
  network: NetworkId
  programId: string
  rpcUrl?: string
  priceSol: number
  requiresAllowlist: boolean
  proof?: string[]
  /** Wallet signer from the active session. */
  signTransaction: <T>(tx: T) => Promise<T>
  onStage?: (attempt: MintAttempt) => void
  signal?: AbortSignal
}

export interface MintReceipt {
  tokenIds: number[]
  signatures: string[]
  totalSol: number
  elapsedMs: number
  demo: boolean
  snapshot?: ChainSnapshot
}

/** Anchor custom error codes from `program/programs/chromafield-mint/src/error.rs`. */
export const PROGRAM_ERRORS: Record<number, { message: string; hint: string; kind: MintFailure['kind'] }> = {
  6000: { message: 'Collection is sold out.', hint: 'Every token has been minted.', kind: 'sold-out' },
  6001: { message: 'Mint has not opened yet.', hint: 'Check the countdown.', kind: 'program' },
  6002: { message: 'Mint has ended.', hint: 'The public window closed.', kind: 'program' },
  6003: { message: 'Wallet is not on the allowlist.', hint: 'Verify your spot before minting.', kind: 'not-allowlisted' },
  6004: { message: 'Allowlist allocation exhausted.', hint: 'Wait for the public phase.', kind: 'program' },
  6005: { message: 'Insufficient payment.', hint: 'Top up and try again.', kind: 'insufficient-funds' },
  6006: { message: 'Minting is paused by the studio.', hint: 'Check the project channels.', kind: 'program' },
  6007: { message: 'Per-wallet limit reached.', hint: `Maximum ${COLLECTION.maxPerWallet} per wallet.`, kind: 'program' },
  6008: { message: 'This mint key was already used.', hint: 'Retry — a fresh keypair will be generated.', kind: 'program' },
  6009: { message: 'Only the collection authority may call this.', hint: 'Wrong wallet.', kind: 'program' },
  6010: { message: 'Unknown phase value stored on-chain.', hint: 'The authority set an invalid phase.', kind: 'program' },
  6011: { message: 'Nothing to withdraw beyond the rent floor.', hint: 'Authority-only instruction.', kind: 'program' },
}

export function failureFromLogs(logs: string[] | null | undefined): MintFailure | null {
  if (!logs?.length) return null
  const joined = logs.join('\n')
  const numbered = joined.match(/Error Number: (\d+)/)
  if (numbered) {
    const code = Number(numbered[1])
    const known = PROGRAM_ERRORS[code]
    if (known) return { kind: known.kind, message: known.message, hint: known.hint, code }
  }
  const named = joined.match(/Error Code: (\w+)/)
  if (named) {
    const hit = Object.entries(PROGRAM_ERRORS).find(
      ([, v]) => v.message.toLowerCase().includes(named[1].toLowerCase()),
    )
    if (hit) return { kind: hit[1].kind, message: hit[1].message, hint: hit[1].hint, code: Number(hit[0]) }
  }
  if (/insufficient/i.test(joined)) {
    return {
      kind: 'insufficient-funds',
      message: 'Not enough SOL for price + rent.',
      hint: `Rent alone is about ${formatSol(Number(rentExemptLamports(MINT_ACCOUNT_SPACE)) / 1e9, 5)} SOL per token.`,
    }
  }
  if (/blockhash/i.test(joined)) {
    return {
      kind: 'network',
      message: 'Blockhash expired before the transaction landed.',
      hint: 'The cluster was congested — retry.',
    }
  }
  return null
}

function stageProgress(index: number, total: number, stage: MintStage): number {
  const stageIndex = Math.max(0, STAGE_ORDER.indexOf(stage))
  const withinBatch = (index - 1) / Math.max(1, total)
  const withinToken = stageIndex / (STAGE_ORDER.length - 1)
  return Math.min(1, withinBatch + withinToken / Math.max(1, total))
}

export async function mintTokens(request: MintRequest): Promise<MintReceipt> {
  const started = Date.now()
  const { quantity, onStage, signal } = request
  const receipt: MintReceipt = {
    tokenIds: [],
    signatures: [],
    totalSol: 0,
    elapsedMs: 0,
    demo: request.isDemo,
  }

  const report = (attempt: MintAttempt) => onStage?.(attempt)
  const checkAbort = () => {
    if (signal?.aborted) {
      report({
        stage: 'cancelled',
        index: 0,
        total: quantity,
        message: 'Cancelled',
        progress: 0,
      })
      throw new MintAbortedError()
    }
  }

  try {
    for (let i = 1; i <= quantity; i++) {
      checkAbort()
      const result = request.isDemo
        ? await mintOneDemo(request, i, quantity, report, signal)
        : await mintOneLive(request, i, quantity, report, signal)
      receipt.tokenIds.push(result.tokenId)
      receipt.signatures.push(result.signature)
      receipt.totalSol += request.priceSol
    }
    receipt.elapsedMs = Date.now() - started
    if (!request.isDemo) {
      receipt.snapshot = await fetchLiveSnapshot(request.network, request.programId, request.rpcUrl)
    } else {
      receipt.snapshot = demoChain.snapshot()
    }
    report({
      stage: 'complete',
      index: quantity,
      total: quantity,
      message:
        quantity === 1
          ? `Token #${pad(receipt.tokenIds[0])} is yours`
          : `${quantity} tokens minted`,
      progress: 1,
      tokenId: receipt.tokenIds[receipt.tokenIds.length - 1],
      signature: receipt.signatures[receipt.signatures.length - 1],
      explorerUrl: explorerUrl(
        'tx',
        receipt.signatures[receipt.signatures.length - 1],
        request.network,
      ),
      detail: {
        cost: `${(receipt.totalSol + (request.isDemo ? 0.0025 * quantity : 0)).toFixed(4)} SOL`,
        elapsed: `${((Date.now() - started) / 1000).toFixed(1)}s`,
      },
    })
    return receipt
  } catch (err) {
    const failure = toFailure(err, request)
    report({
      stage: err instanceof MintAbortedError ? 'cancelled' : 'error',
      index: 0,
      total: quantity,
      message: failure.message,
      progress: 0,
      error: failure,
      explorerUrl:
        receipt.signatures.length > 0
          ? explorerUrl('tx', receipt.signatures[receipt.signatures.length - 1], request.network)
          : undefined,
    })
    throw new MintFailedError(failure)
  }
}

export class MintAbortedError extends Error {
  constructor() {
    super('cancelled')
    this.name = 'MintAbortedError'
  }
}

export class MintFailedError extends Error {
  constructor(readonly failure: MintFailure) {
    super(failure.message)
    this.name = 'MintFailedError'
  }
}

function toFailure(err: unknown, request: MintRequest): MintFailure {
  if (err instanceof MintAbortedError) {
    return { kind: 'unknown', message: 'Cancelled before the transaction landed.' }
  }
  if (err instanceof MintFailedError) return err.failure
  if (err instanceof WalletError) {
    return {
      kind: err.kind === 'rejected' ? 'rejected' : err.kind === 'not-installed' ? 'wallet' : 'wallet',
      message: err.message,
      hint:
        err.kind === 'not-installed'
          ? 'Install the extension, or switch to Demo Mode in settings.'
          : 'Nothing was broadcast — you can retry safely.',
    }
  }
  const message = err instanceof Error ? err.message : String(err)
  if (/fetch|network|timeout|rpc|Failed to fetch/i.test(message)) {
    return {
      kind: 'network',
      message: 'Could not reach the Solana RPC endpoint.',
      hint: `Check the ${NETWORKS[request.network].label} RPC URL in settings, or stay in Demo Mode.`,
    }
  }
  return { kind: 'unknown', message: message || 'Mint failed for an unknown reason.', hint: 'Retry, or switch to Demo Mode.' }
}

function pad(tokenId: number | undefined): string {
  return (tokenId ?? 0).toString().padStart(4, '0')
}

/* ------------------------------------------------------------ demo path */

interface OneMintResult {
  tokenId: number
  signature: string
}

async function mintOneDemo(
  request: MintRequest,
  index: number,
  total: number,
  report: (a: MintAttempt) => void,
  signal?: AbortSignal,
): Promise<OneMintResult> {
  const emit = (stage: MintStage, message: string, extra: Partial<MintAttempt> = {}) =>
    report({
      stage,
      index,
      total,
      message,
      progress: stageProgress(index, total, stage),
      ...extra,
    })

  emit('preflight', 'Checking supply, phase and balance…')
  await sleep(320 + Math.random() * 240)
  if (signal?.aborted) throw new MintAbortedError()

  const snapshot = demoChain.snapshot()
  if (snapshot.totalMinted >= COLLECTION.maxSupply) {
    throw new MintFailedError({ kind: 'sold-out', message: 'Collection is sold out.' })
  }
  if (request.requiresAllowlist) {
    emit('preflight', 'Verifying Merkle proof against the allowlist root…')
    await sleep(280)
  }

  const [tokenId] = demoChain.availableTokens(1)
  emit('building', `Deriving mint, metadata and token-account PDAs for #${pad(tokenId)}…`, {
    detail: {
      mintSpace: `${MINT_ACCOUNT_SPACE} bytes`,
      rent: `${formatSol(Number(rentExemptLamports(MINT_ACCOUNT_SPACE)) / 1e9, 5)} SOL`,
      ata: ATA_ACCOUNT_ORDER.join(' → '),
    },
  })
  await sleep(380 + Math.random() * 260)
  if (signal?.aborted) throw new MintAbortedError()

  const seedBytes = keccak256(
    new TextEncoder().encode(`chromafield|${request.address}|${tokenId}|${Date.now()}`),
  )
  const mintKeypairPub = base58Encode(seedBytes)
  emit('awaiting-signature', 'Approve the transaction in your wallet…', {
    detail: { mint: mintKeypairPub, feePayer: request.address },
  })
  // Real signature round-trip through the (demo) wallet adapter.
  await request.signTransaction({ __demoTx: true, tokenId })
  if (signal?.aborted) throw new MintAbortedError()

  const signature = base58Encode(
    concat(seedBytes, keccak256(concat(seedBytes, new TextEncoder().encode('sig')))),
  )
  emit('submitting', 'Broadcasting to the cluster…', { signature })
  await sleep(420 + Math.random() * 300)

  const slot = 348_201_447 + (tokenId % 90_000)
  emit('confirming', `Waiting for confirmation · slot ${slot.toLocaleString('en-US')}`, {
    signature,
    slot,
    explorerUrl: explorerUrl('tx', signature, request.network),
  })
  await sleep(900 + Math.random() * 700)

  const cost = solToLamports(request.priceSol) + rentExemptLamports(MINT_ACCOUNT_SPACE)
  const [entry] = demoChain.mint(1, request.address, cost)
  emit('complete', `Token #${pad(entry?.tokenId ?? tokenId)} confirmed`, {
    tokenId: entry?.tokenId ?? tokenId,
    signature,
    slot,
    explorerUrl: explorerUrl('tx', signature, request.network),
  })
  return { tokenId: entry?.tokenId ?? tokenId, signature }
}

function concat(a: Uint8Array, b: Uint8Array): Uint8Array {
  const out = new Uint8Array(a.length + b.length)
  out.set(a, 0)
  out.set(b, a.length)
  return out
}

/* ------------------------------------------------------------ live path */

async function mintOneLive(
  request: MintRequest,
  index: number,
  total: number,
  report: (a: MintAttempt) => void,
  signal?: AbortSignal,
): Promise<OneMintResult> {
  const emit = (stage: MintStage, message: string, extra: Partial<MintAttempt> = {}) =>
    report({
      stage,
      index,
      total,
      message,
      progress: stageProgress(index, total, stage),
      ...extra,
    })

  emit('preflight', `Reading the Collection account on ${NETWORKS[request.network].label}…`)
  const web3 = await withWeb3()
  const connection = new web3.Connection(
    request.rpcUrl?.trim() || NETWORKS[request.network].rpc,
    'confirmed',
  )
  const programId = new web3.PublicKey(request.programId)
  const payer = new web3.PublicKey(request.address)

  const [collectionPda, balance, before] = await Promise.all([
    deriveCollectionPda(request.programId),
    fetchBalance(request.address, request.network, request.rpcUrl),
    fetchLiveSnapshot(request.network, request.programId, request.rpcUrl),
  ])
  if (before.source === 'offline') {
    throw new MintFailedError({
      kind: 'network',
      message: before.error ?? 'Could not read the Collection account.',
      hint: 'Verify the program ID and RPC URL in settings.',
    })
  }
  if (before.totalMinted >= before.maxSupply) {
    throw new MintFailedError({ kind: 'sold-out', message: 'Collection is sold out.' })
  }
  const needed = solToLamports(request.priceSol) + rentExemptLamports(MINT_ACCOUNT_SPACE) + 10_000n
  if (balance !== null && BigInt(Math.floor(balance * 1e9)) < needed) {
    throw new MintFailedError({
      kind: 'insufficient-funds',
      message: `Balance too low — ${balance.toFixed(3)} SOL available.`,
      hint: `This mint needs about ${(Number(needed) / 1e9).toFixed(4)} SOL including rent and fees.`,
    })
  }
  if (signal?.aborted) throw new MintAbortedError()

  emit('building', 'Generating mint keypair and deriving PDAs…')
  const mintKeypair = web3.Keypair.generate()
  const mintAddress = mintKeypair.publicKey.toBase58()
  const [mintStatePda, metadataPda, masterEditionPda, walletStatePda, ata] = await Promise.all([
    deriveMintStatePda(request.programId, mintAddress),
    deriveMetadataPda(mintAddress),
    deriveMasterEditionPda(mintAddress),
    deriveWalletStatePda(request.programId, request.address),
    deriveAta(request.address, mintAddress),
  ])

  const ixData = encodeMintNftData(request.requiresAllowlist ? request.proof ?? [] : [])
  const ataIx = new web3.TransactionInstruction({
    programId: new web3.PublicKey(CONTRACT.ataProgramId),
    keys: [
      { pubkey: payer, isSigner: true, isWritable: true }, // funder
      { pubkey: payer, isSigner: false, isWritable: true }, // wallet (ata owner)
      { pubkey: mintKeypair.publicKey, isSigner: false, isWritable: false }, // mint
      { pubkey: new web3.PublicKey(ata), isSigner: false, isWritable: true }, // ata
      { pubkey: web3.SystemProgram.programId, isSigner: false, isWritable: false },
      { pubkey: new web3.PublicKey(CONTRACT.tokenProgramId), isSigner: false, isWritable: false },
    ],
    data: Buffer.from(encodeCreateAtaIdempotent()),
  })

  // Account order must match `MintNft` in program/.../src/lib.rs exactly.
  const mintIx = new web3.TransactionInstruction({
    programId,
    keys: [
      /* 00 */ { pubkey: payer, isSigner: true, isWritable: true },
      /* 01 */ { pubkey: new web3.PublicKey(collectionPda), isSigner: false, isWritable: true },
      /* 02 */ { pubkey: new web3.PublicKey(mintStatePda), isSigner: false, isWritable: true },
      /* 03 */ { pubkey: mintKeypair.publicKey, isSigner: true, isWritable: true },
      /* 04 */ { pubkey: new web3.PublicKey(metadataPda), isSigner: false, isWritable: true },
      /* 05 */ { pubkey: new web3.PublicKey(masterEditionPda), isSigner: false, isWritable: true },
      /* 06 */ { pubkey: new web3.PublicKey(ata), isSigner: false, isWritable: true },
      /* 07 */ { pubkey: payer, isSigner: false, isWritable: false },
      /* 08 */ { pubkey: new web3.PublicKey(walletStatePda), isSigner: false, isWritable: true },
      /* 09 */ { pubkey: new web3.PublicKey(CONTRACT.treasury), isSigner: false, isWritable: true },
      /* 10 */ { pubkey: new web3.PublicKey(CONTRACT.tokenProgramId), isSigner: false, isWritable: false },
      /* 11 */ { pubkey: new web3.PublicKey(CONTRACT.ataProgramId), isSigner: false, isWritable: false },
      /* 12 */ { pubkey: new web3.PublicKey(CONTRACT.metadataProgramId), isSigner: false, isWritable: false },
      /* 13 */ { pubkey: web3.SystemProgram.programId, isSigner: false, isWritable: false },
      /* 14 */ { pubkey: web3.SYSVAR_INSTRUCTIONS_PUBKEY, isSigner: false, isWritable: false },
    ],
    data: Buffer.from(ixData),
  })

  const blockhash = await connection.getLatestBlockhash('confirmed')
  const tx = new web3.Transaction({
    feePayer: payer,
    blockhash: blockhash.blockhash,
    lastValidBlockHeight: blockhash.lastValidBlockHeight,
  }).add(ataIx, mintIx)

  tx.partialSign(mintKeypair)
  if (signal?.aborted) throw new MintAbortedError()

  emit('awaiting-signature', 'Approve the transaction in your wallet…', {
    detail: {
      mint: mintKeypair.publicKey.toBase58(),
      ata,
      blockhash: blockhash.blockhash.slice(0, 12) + '…',
    },
  })
  const signed = await request.signTransaction(tx)
  if (signal?.aborted) throw new MintAbortedError()

  emit('submitting', 'Broadcasting to the cluster…')
  const raw = (signed as Transaction).serialize({
    requireAllSignatures: false,
    verifySignatures: false,
  })
  const signature = await connection.sendRawTransaction(raw, {
    skipPreflight: false,
    maxRetries: 3,
  })
  emit('submitting', 'Transaction broadcast', {
    signature,
    explorerUrl: explorerUrl('tx', signature, request.network),
  })

  emit('confirming', 'Waiting for confirmation…', {
    signature,
    explorerUrl: explorerUrl('tx', signature, request.network),
  })
  const confirmation = await connection.confirmTransaction(
    {
      signature,
      blockhash: blockhash.blockhash,
      lastValidBlockHeight: blockhash.lastValidBlockHeight,
    },
    'confirmed',
  )
  if (confirmation.value.err) {
    const logs = await connection
      .getTransaction(signature, { maxSupportedTransactionVersion: 0 })
      .then((t) => t?.meta?.logMessages ?? null)
      .catch(() => null)
    const failure = failureFromLogs(logs)
    throw new MintFailedError(
      failure ?? {
        kind: 'program',
        message: 'Transaction failed on-chain.',
        hint: logs?.slice(-3).join(' · ') ?? 'Inspect the transaction for details.',
      },
    )
  }

  const after = await fetchLiveSnapshot(request.network, request.programId, request.rpcUrl)
  const tokenId = Math.max(before.totalMinted + 1, after.totalMinted)
  const slot = await connection.getSlot('confirmed').catch(() => undefined)

  emit('complete', `Token #${pad(tokenId)} confirmed`, {
    tokenId,
    signature,
    slot,
    explorerUrl: explorerUrl('tx', signature, request.network),
  })
  return { tokenId, signature }
}
