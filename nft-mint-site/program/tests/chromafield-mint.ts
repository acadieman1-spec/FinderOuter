/**
 * Program tests (run with `anchor test`, which spins up a local validator).
 *
 * The schedule is chosen relative to *now* so the tests exercise the allowlist
 * window without needing to manipulate the clock sysvar.
 */

import * as anchor from '@coral-xyz/anchor'
import type { Program } from '@coral-xyz/anchor'
import {
  ASSOCIATED_TOKEN_PROGRAM_ID,
  TOKEN_PROGRAM_ID,
  getAccount,
  getAssociatedTokenAddressSync,
} from '@solana/spl-token'
import { Keypair, LAMPORTS_PER_SOL, PublicKey, SYSVAR_INSTRUCTIONS_PUBKEY } from '@solana/web3.js'
import { expect } from 'chai'
import type { ChromafieldMint } from '../target/types/chromafield_mint'
import { MerkleTree } from '../scripts/merkle'

const METADATA_PROGRAM_ID = new PublicKey('metaqbxxUerdq28cj1RbAWkYQm3ybzjb6a8bt518x1s')
const COLLECTION_SEED = Buffer.from('collection')
const MINT_STATE_SEED = Buffer.from('mint_state')
const WALLET_STATE_SEED = Buffer.from('wallet_state')

describe('chromafield-mint', () => {
  const provider = anchor.AnchorProvider.env()
  anchor.setProvider(provider)
  const program = anchor.workspace.ChromafieldMint as Program<ChromafieldMint>

  const authority = provider.wallet.publicKey
  const treasury = Keypair.generate().publicKey
  const outsider = Keypair.generate().publicKey

  const allowlist = [authority.toBase58(), outsider.toBase58()]
  const tree = new MerkleTree(allowlist)

  const now = Math.floor(Date.now() / 1000)
  const maxPerWallet = 2

  const initArgs = {
    treasury,
    priceLamports: new anchor.BN(0.35 * LAMPORTS_PER_SOL),
    allowlistPriceLamports: new anchor.BN(0.25 * LAMPORTS_PER_SOL),
    maxSupply: 10,
    allowlistAllocation: 5,
    maxPerWallet,
    royaltyBps: 500,
    allowlistRoot: Array.from(tree.root),
    allowlistStart: new anchor.BN(now - 60),
    publicStart: new anchor.BN(now + 3600),
    endsAt: new anchor.BN(now + 86_400),
    uriBase: 'https://chromafield.dev/api/meta/',
    name: 'CHROMAFIELD',
    symbol: 'CHRM',
    generatorVersion: '1.4.0',
  }

  let collection: PublicKey

  const proofFor = (address: string): number[][] =>
    tree.proof(allowlist.indexOf(address)).map((hex) => Array.from(Buffer.from(hex, 'hex')))

  async function mint(receiver: PublicKey, proof: number[][]) {
    const mint = Keypair.generate()
    const [mintState] = PublicKey.findProgramAddressSync(
      [MINT_STATE_SEED, mint.publicKey.toBuffer()],
      program.programId,
    )
    const [walletState] = PublicKey.findProgramAddressSync(
      [WALLET_STATE_SEED, receiver.toBuffer()],
      program.programId,
    )
    const [metadata] = PublicKey.findProgramAddressSync(
      [Buffer.from('metadata'), METADATA_PROGRAM_ID.toBuffer(), mint.publicKey.toBuffer()],
      METADATA_PROGRAM_ID,
    )
    const [masterEdition] = PublicKey.findProgramAddressSync(
      [Buffer.from('metadata'), METADATA_PROGRAM_ID.toBuffer(), mint.publicKey.toBuffer(), Buffer.from('edition')],
      METADATA_PROGRAM_ID,
    )
    const ata = getAssociatedTokenAddressSync(mint.publicKey, receiver)

    return program.methods
      .mintNft(proof)
      .accounts({
        payer: authority,
        collection,
        mintState,
        mint: mint.publicKey,
        metadata,
        masterEdition,
        receiverTokenAccount: ata,
        receiver,
        walletState,
        treasury,
        tokenProgram: TOKEN_PROGRAM_ID,
        associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
        metadataProgram: METADATA_PROGRAM_ID,
        systemProgram: anchor.web3.SystemProgram.programId,
        sysvarInstructions: SYSVAR_INSTRUCTIONS_PUBKEY,
      })
      .signers([mint])
      .rpc()
  }

  before(async () => {
    ;[collection] = PublicKey.findProgramAddressSync([COLLECTION_SEED], program.programId)
    await program.methods.initializeCollection(initArgs).accounts({ collection }).rpc()
  })

  it('stores the configuration on the Collection PDA', async () => {
    const state = await program.account.collection.fetch(collection)
    expect(state.maxSupply).to.equal(10)
    expect(state.totalMinted).to.equal(0)
    expect(state.authority.toString()).to.equal(authority.toString())
    expect(state.treasury.toString()).to.equal(treasury.toString())
    expect(Buffer.from(state.allowlistRoot).toString('hex')).to.equal(tree.rootHex)
  })

  it('mints one indivisible token to an allowlisted wallet', async () => {
    const treasuryBefore = await provider.connection.getBalance(treasury)
    await mint(authority, proofFor(authority.toBase58()))

    const state = await program.account.collection.fetch(collection)
    expect(state.totalMinted).to.equal(1)
    expect(state.allowlistMinted).to.equal(1)
    expect(state.phase).to.equal(1) // still allowlist — supply not exhausted

    const treasuryAfter = await provider.connection.getBalance(treasury)
    expect(treasuryAfter - treasuryBefore).to.equal(0.25 * LAMPORTS_PER_SOL)
  })

  it('creates an associated token account holding exactly one unit', async () => {
    const mintStates = await program.account.mintState.all()
    expect(mintStates).to.have.length(1)
    const record = mintStates[0].account
    expect(record.tokenIndex).to.equal(1)
    expect(record.owner.toString()).to.equal(authority.toString())

    const ata = getAssociatedTokenAddressSync(new PublicKey(record.mint), authority)
    const tokenAccount = await getAccount(provider.connection, ata)
    expect(Number(tokenAccount.amount)).to.equal(1)
    expect(tokenAccount.mintAuthority).to.equal(null) // dropped after minting
  })

  it('rejects a wallet that is not on the allowlist', async () => {
    const stranger = Keypair.generate().publicKey
    try {
      await mint(stranger, proofFor(authority.toBase58()))
      expect.fail('expected the mint to be rejected')
    } catch (err) {
      expect(String((err as Error).message)).to.match(/NotAllowlisted|0x1773/)
    }
  })

  it('enforces the per-wallet cap', async () => {
    await mint(authority, proofFor(authority.toBase58()))
    try {
      await mint(authority, proofFor(authority.toBase58()))
      expect.fail('expected the cap to be enforced')
    } catch (err) {
      expect(String((err as Error).message)).to.match(/MaxPerWalletExceeded|0x1777/)
    }
  })

  it('lets the authority move the phase and pause', async () => {
    await program.methods.updatePhase(2, true).accounts({ collection }).rpc()
    const state = await program.account.collection.fetch(collection)
    expect(state.phase).to.equal(2)
    expect(state.paused).to.equal(true)

    try {
      await mint(authority, proofFor(authority.toBase58()))
      expect.fail('expected minting to be paused')
    } catch (err) {
      expect(String((err as Error).message)).to.match(/Paused|0x1776/)
    }
  })

  it('refuses admin calls from a non-authority wallet', async () => {
    const impostor = Keypair.generate()
    try {
      await program.methods
        .updatePhase(3, false)
        .accounts({ collection, authority: impostor.publicKey })
        .signers([impostor])
        .rpc()
      expect.fail('expected an authorization failure')
    } catch (err) {
      expect(String((err as Error).message)).to.match(/Unauthorized|0x1779|Signature verification failed/)
    }
  })
})
