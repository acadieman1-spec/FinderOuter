import { useEffect, useState } from 'react'
import { CONTRACT, NETWORKS } from '@/config'
import { useCopy } from '@/hooks'
import { cn } from '@/lib/cn'
import { shortAddress } from '@/lib/format'
import { deriveCollectionPda, DISCRIMINATORS, MINT_ACCOUNT_SPACE } from '@/lib/program'
import { useApp } from '@/state/AppState'
import { Reveal } from './Reveal'
import { SectionHead } from './SectionHead'
import { IconCheck, IconCopy } from './Icons'

const ACCOUNT_ORDER = [
  'payer',
  'collection (PDA, mutable)',
  'mint_state (PDA, init)',
  'mint (new keypair, signer)',
  'metadata (Metaplex PDA)',
  'receiver_token_account (ATA)',
  'receiver',
  'treasury',
  'token_program',
  'associated_token_program',
  'system_program',
  'metadata_program',
  'rent sysvar',
]

const CHECKS = [
  'Authority can never mint for free — the price check is unconditional.',
  'Token numbers come from the on-chain counter, so rarity cannot be pre-selected.',
  'The allowlist is a 32-byte Merkle root: the list itself is never published.',
  `Rent for the ${MINT_ACCOUNT_SPACE}-byte mint account is paid by the minter and stays with the account.`,
  'Withdraw is authority-only and moves the treasury balance in one instruction.',
]

export function Provenance() {
  const { settings } = useApp()
  const { copied, copy } = useCopy()
  const [collectionPda, setCollectionPda] = useState<string | null>(null)

  const programId = settings.mode === 'live' && settings.programId.trim() ? settings.programId.trim() : CONTRACT.programId

  useEffect(() => {
    let alive = true
    deriveCollectionPda(programId)
      .then((pda) => {
        if (alive) setCollectionPda(pda)
      })
      .catch(() => {
        if (alive) setCollectionPda(null)
      })
    return () => {
      alive = false
    }
  }, [programId])

  const rows = [
    { label: 'Program ID', value: programId },
    { label: 'Collection PDA', value: collectionPda ?? 'deriving…' },
    { label: 'Authority', value: CONTRACT.authority },
    { label: 'Treasury', value: CONTRACT.treasury },
    { label: 'Metadata program', value: CONTRACT.metadataProgramId },
    { label: 'Token program', value: CONTRACT.tokenProgramId },
  ]

  return (
    <section className="section" id="provenance">
      <div className="shell">
        <SectionHead
          eyebrow="Provenance"
          title={
            <>
              What actually goes <span className="grad-text">on-chain</span>.
            </>
          }
          lede={`One instruction, thirteen accounts, ${DISCRIMINATORS.mintNft.join(' ')} as the Anchor discriminator. The program source lives in /program — build it with anchor build, deploy it, then paste the address into settings.`}
          aside={<span className="chip chip--cyan">{NETWORKS[settings.network].label}</span>}
        />

        <div className="provenance">
          <Reveal>
            <div className="stack gap-4">
              <p className="lede" style={{ fontSize: 15.5 }}>
                The client and the program agree on one thing only: the account list and the instruction layout below.
                Everything else — price, phase, supply, allowlist root — is read from the Collection account at mint time,
                so the website can never lie to you about the state of the drop.
              </p>

              <div className="checks">
                {CHECKS.map((check) => (
                  <div className="check" key={check}>
                    <IconCheck size={15} />
                    <span>{check}</span>
                  </div>
                ))}
              </div>

              <dl className="kv">
                {rows.map((row) => (
                  <div className="kv__row" key={row.label}>
                    <dt>{row.label}</dt>
                    <dd>
                      <span title={row.value}>{shortAddress(row.value, 6, 6)}</span>
                      <button
                        type="button"
                        className={cn('copy-btn', copied === row.label && 'is-copied')}
                        onClick={() => void copy(row.value, row.label)}
                        aria-label={`Copy ${row.label}`}
                      >
                        <IconCopy size={13} />
                      </button>
                    </dd>
                  </div>
                ))}
              </dl>
            </div>
          </Reveal>

          <Reveal delay={80}>
            <div className="stack gap-4">
              <div className="codeblock">
                <div className="codeblock__head">
                  <span className="codeblock__title">programs/chromafield-mint/src/lib.rs</span>
                  <button
                    type="button"
                    className={cn('copy-btn', copied === 'snippet' && 'is-copied')}
                    onClick={() => void copy(SNIPPET_TEXT, 'snippet')}
                    aria-label="Copy snippet"
                  >
                    <IconCopy size={13} />
                  </button>
                </div>
                <pre>
                  <code>
                    <span className="c-com">{'// Account order the dApp must match exactly.'}</span>
                    {'\n'}
                    <span className="c-key">#[derive(Accounts)]</span>
                    {'\n'}
                    <span className="c-key">pub struct</span> MintNft&lt;<span className="c-str">'info'</span>&gt; {'{'}
                    {'\n    '}
                    <span className="c-key">#[account(mut)]</span> <span className="c-key">pub</span> payer: Signer&lt;
                    <span className="c-str">'info'</span>&gt;,
                    {'\n    '}
                    <span className="c-key">#[account(mut, seeds = [b"collection"], bump)]</span>
                    {'\n    '}
                    <span className="c-key">pub</span> collection: Account&lt;<span className="c-str">'info'</span>, Collection&gt;,
                    {'\n    '}
                    <span className="c-key">#[account(init, payer = payer, space = 8 + MintState::LEN,</span>
                    {'\n             '}
                    <span className="c-key">seeds = [b"mint_state", mint.key().as_ref()], bump)]</span>
                    {'\n    '}
                    <span className="c-key">pub</span> mint_state: Account&lt;<span className="c-str">'info'</span>, MintState&gt;,
                    {'\n    '}
                    <span className="c-key">#[account(mut)]</span> <span className="c-key">pub</span> mint: Signer&lt;
                    <span className="c-str">'info'</span>&gt;,
                    {'\n    '}
                    <span className="c-com">/// CHECK: written by the metadata CPI</span>
                    {'\n    '}
                    <span className="c-key">#[account(mut)]</span> <span className="c-key">pub</span> metadata: UncheckedAccount&lt;
                    <span className="c-str">'info'</span>&gt;,
                    {'\n    '}
                    <span className="c-key">pub</span> receiver_token_account: Account&lt;<span className="c-str">'info'</span>, TokenAccount&gt;,
                    {'\n    '}
                    <span className="c-com">/* … receiver, treasury, token_program, ata_program,</span>
                    {'\n       '}
                    <span className="c-com">system_program, metadata_program, rent */</span>
                    {'\n}'}
                    {'\n\n'}
                    <span className="c-key">pub fn</span> mint_nft(ctx: Context&lt;MintNft&gt;, proof: Vec&lt;[
                    <span className="c-key">u8</span>; <span className="c-num">32</span>]&gt;) -&gt; Result&lt;()&gt;
                  </code>
                </pre>
              </div>

              <div className="codeblock">
                <div className="codeblock__head">
                  <span className="codeblock__title">instruction accounts · in order</span>
                </div>
                <pre>
                  <code>
                    {ACCOUNT_ORDER.map((name, i) => (
                      <span key={name}>
                        <span className="c-num">{String(i).padStart(2, '0')}</span>
                        {'  '}
                        {name}
                        {'\n'}
                      </span>
                    ))}
                  </code>
                </pre>
              </div>
            </div>
          </Reveal>
        </div>
      </div>
    </section>
  )
}

const SNIPPET_TEXT = `#[derive(Accounts)]
pub struct MintNft<'info> {
    #[account(mut)] pub payer: Signer<'info>,
    #[account(mut, seeds = [b"collection"], bump)]
    pub collection: Account<'info, Collection>,
    #[account(init, payer = payer, space = 8 + MintState::LEN,
              seeds = [b"mint_state", mint.key().as_ref()], bump)]
    pub mint_state: Account<'info, MintState>,
    #[account(mut)] pub mint: Signer<'info>,
    /// CHECK: written by the metadata CPI
    #[account(mut)] pub metadata: UncheckedAccount<'info>,
    pub receiver_token_account: Account<'info, TokenAccount>,
    /* … receiver, treasury, token_program, ata_program,
       system_program, metadata_program, rent */
}

pub fn mint_nft(ctx: Context<MintNft>, proof: Vec<[u8; 32]>) -> Result<()>`
