import { ActivityFeed } from './ActivityFeed'
import { AllowlistCard } from './AllowlistCard'
import { MintPanel } from './MintPanel'
import { PhaseTimeline } from './PhaseTimeline'
import { Reveal } from './Reveal'
import { SectionHead } from './SectionHead'
import { SupplyMeter } from './SupplyMeter'
import { YourTokens } from './YourTokens'

interface MintSectionProps {
  onConnectWallet: () => void
}

export function MintSection({ onConnectWallet }: MintSectionProps) {
  const scrollToPanel = () => {
    document.getElementById('mint-panel')?.scrollIntoView({ behavior: 'smooth', block: 'center' })
  }

  return (
    <section className="section" id="mint">
      <div className="shell">
        <SectionHead
          eyebrow="Mint"
          title={
            <>
              Claim a field in <span className="grad-text">one transaction</span>.
            </>
          }
          lede="The program creates the token mint, writes Metaplex metadata with your seed, and pays the treasury — all in a single instruction you approve once."
        />

        <div className="mint__grid">
          <div className="mint__col">
            <Reveal>
              <PhaseTimeline />
            </Reveal>
            <Reveal delay={60}>
              <SupplyMeter />
            </Reveal>
            <Reveal delay={90}>
              <AllowlistCard />
            </Reveal>
            <Reveal delay={120}>
              <ActivityFeed />
            </Reveal>
          </div>

          <div className="mint__side">
            <Reveal delay={40}>
              <MintPanel onConnectWallet={onConnectWallet} />
            </Reveal>
            <Reveal delay={80}>
              <YourTokens onMint={scrollToPanel} />
            </Reveal>
          </div>
        </div>
      </div>
    </section>
  )
}
