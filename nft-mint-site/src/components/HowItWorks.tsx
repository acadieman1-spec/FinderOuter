import { Reveal } from './Reveal'
import { SectionHead } from './SectionHead'

const STEPS = [
  {
    n: '01',
    title: 'Connect a wallet',
    body: 'Phantom, Solflare or Backpack are detected automatically. No extension? Demo Mode signs locally so you can walk the whole flow first.',
  },
  {
    n: '02',
    title: 'Approve one transaction',
    body: 'A single instruction creates the token mint, the associated token account and the Metaplex metadata record, and pays the treasury.',
  },
  {
    n: '03',
    title: 'The program assigns a seed',
    body: 'Token numbers are handed out by the on-chain counter in mint order, so nobody — including us — can pick a rare field ahead of you.',
  },
  {
    n: '04',
    title: 'Render it anywhere, forever',
    body: 'The seed and generator version live in the metadata URI. Any wallet, any site, any year: same input, same field.',
  },
]

export function HowItWorks() {
  return (
    <section className="section" id="how">
      <div className="shell">
        <SectionHead
          eyebrow="How it works"
          title={
            <>
              Four steps, <span className="grad-text">one signature</span>.
            </>
          }
          lede="No approvals to revoke, no off-chain reveals, no waiting for a pinning service. You sign once and the field exists."
        />
        <div className="steps">
          {STEPS.map((step, i) => (
            <Reveal key={step.n} delay={i * 70}>
              <div className="step-card">
                <span className="step-card__num">{step.n}</span>
                <h3>{step.title}</h3>
                <p>{step.body}</p>
              </div>
            </Reveal>
          ))}
        </div>
      </div>
    </section>
  )
}
