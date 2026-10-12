/**
 * Initialise the Collection account after deploy.
 *
 * Values come from the environment so the same script works for devnet and
 * mainnet without editing code:
 *
 *   TREASURY=<pubkey> \
 *   PRICE_SOL=0.35 ALLOWLIST_PRICE_SOL=0.25 \
 *   MAX_SUPPLY=2048 ALLOWLIST_ALLOCATION=768 MAX_PER_WALLET=4 \
 *   ALLOWLIST_ROOT_HEX=ab12… \
 *   ALLOWLIST_START=2026-10-08T18:00:00Z PUBLIC_START=2026-10-14T18:00:00Z ENDS_AT=2026-10-28T18:00:00Z \
 *   URI_BASE=https://chromafield.dev/api/meta/ \
 *   npx ts-node scripts/init-collection.ts
 */

import * as anchor from '@coral-xyz/anchor'
import { LAMPORTS_PER_SOL, PublicKey } from '@solana/web3.js'
import { ChromafieldMint } from '../target/types/chromafield_mint'

const COLLECTION_SEED = Buffer.from('collection')

function env(name: string, fallback?: string): string {
  const value = process.env[name] ?? fallback
  if (value === undefined) throw new Error(`Missing env var ${name}`)
  return value
}

function unixSeconds(value: string): anchor.BN {
  return new anchor.BN(Math.floor(new Date(value).getTime() / 1000))
}

async function main() {
  const provider = anchor.AnchorProvider.env()
  anchor.setProvider(provider)
  const program = anchor.workspace.ChromafieldMint as anchor.Program<ChromafieldMint>

  const [collection] = PublicKey.findProgramAddressSync([COLLECTION_SEED], program.programId)

  const rootHex = env('ALLOWLIST_ROOT_HEX').replace(/^0x/, '')
  const args = {
    treasury: new PublicKey(env('TREASURY')),
    priceLamports: new anchor.BN(Math.round(parseFloat(env('PRICE_SOL', '0.35')) * LAMPORTS_PER_SOL)),
    allowlistPriceLamports: new anchor.BN(
      Math.round(parseFloat(env('ALLOWLIST_PRICE_SOL', '0.25')) * LAMPORTS_PER_SOL),
    ),
    maxSupply: Number(env('MAX_SUPPLY', '2048')),
    allowlistAllocation: Number(env('ALLOWLIST_ALLOCATION', '768')),
    maxPerWallet: Number(env('MAX_PER_WALLET', '4')),
    royaltyBps: Number(env('ROYALTY_BPS', '500')),
    allowlistRoot: Array.from(Buffer.from(rootHex, 'hex')),
    allowlistStart: unixSeconds(env('ALLOWLIST_START')),
    publicStart: unixSeconds(env('PUBLIC_START')),
    endsAt: unixSeconds(env('ENDS_AT')),
    uriBase: env('URI_BASE', 'https://chromafield.dev/api/meta/'),
    name: env('NAME', 'CHROMAFIELD'),
    symbol: env('SYMBOL', 'CHRM'),
    generatorVersion: env('GENERATOR_VERSION', '1.4.0'),
  }

  const existing = await provider.connection.getAccountInfo(collection)
  if (existing) {
    console.log(`Collection account already exists at ${collection.toBase58()} — skipping init.`)
    return
  }

  console.log('initialising', collection.toBase58())
  const tx = await program.methods.initializeCollection(args).accounts({ collection }).rpc()
  console.log('signature', tx)
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
