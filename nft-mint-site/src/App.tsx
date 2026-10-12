import { useCallback, useState } from 'react'
import { Faq } from './components/Faq'
import { Footer } from './components/Footer'
import { Gallery } from './components/Gallery'
import { Hero } from './components/Hero'
import { HowItWorks } from './components/HowItWorks'
import { MintSection } from './components/MintSection'
import { Nav } from './components/Nav'
import { Provenance } from './components/Provenance'
import { RaritySection } from './components/RaritySection'
import { Roadmap } from './components/Roadmap'
import { SettingsDrawer } from './components/SettingsDrawer'
import { StatsBar } from './components/StatsBar'
import { Ticker } from './components/Ticker'
import { Toasts } from './components/Toasts'
import { WalletModal } from './components/WalletModal'
import { AppProvider } from './state/AppState'

export default function App() {
  return (
    <AppProvider>
      <Site />
    </AppProvider>
  )
}

function Site() {
  const [walletOpen, setWalletOpen] = useState(false)
  const [settingsOpen, setSettingsOpen] = useState(false)

  const scrollToMint = useCallback(() => {
    document.getElementById('mint')?.scrollIntoView({ behavior: 'smooth', block: 'start' })
  }, [])

  return (
    <>
      <a className="skip-link" href="#mint">
        Skip to the mint panel
      </a>

      <Nav onOpenWallet={() => setWalletOpen(true)} onOpenSettings={() => setSettingsOpen(true)} />

      <main>
        <Hero onMint={scrollToMint} />
        <Ticker />
        <section className="section section--tight" aria-label="Collection statistics">
          <StatsBar />
        </section>

        <MintSection onConnectWallet={() => setWalletOpen(true)} />
        <Gallery />
        <RaritySection />
        <HowItWorks />
        <Provenance />
        <Roadmap />
        <Faq />
      </main>

      <Footer onOpenSettings={() => setSettingsOpen(true)} />

      <WalletModal open={walletOpen} onClose={() => setWalletOpen(false)} />
      <SettingsDrawer open={settingsOpen} onClose={() => setSettingsOpen(false)} />
      <Toasts />
    </>
  )
}
