import { cleanup, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it } from 'vitest'
import App from '@/App'

afterEach(cleanup)

type User = ReturnType<typeof userEvent.setup>

const CTA = /^(mint \d+ fields?|verify allowlist spot)/i

async function connectDemoWallet(user: User) {
  await user.click(screen.getByRole('button', { name: 'Connect' }))
  const dialog = await screen.findByRole('dialog', { name: 'Connect a wallet' })
  await user.click(within(dialog).getByRole('button', { name: /demo wallet/i }))
  await waitFor(() => expect(screen.getByText(/demo wallet connected/i)).toBeTruthy(), {
    timeout: 15_000,
  })
  await user.click(screen.getByRole('button', { name: 'Close' }))
}

/** Clicks the mint card's primary action and reports the label it carried. */
async function clickPrimaryCta(user: User): Promise<string> {
  const button = screen.getByRole('button', { name: CTA })
  const label = (button.textContent ?? '').trim()
  await user.click(button)
  return label
}

describe('app shell', () => {
  it('renders the hero, the mint panel and the gallery', () => {
    render(<App />)
    expect(screen.getByText('CHROMA')).toBeTruthy()
    expect(screen.getByText('FIELD')).toBeTruthy()
    expect(screen.getByRole('button', { name: /mint a field/i })).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Connect' })).toBeTruthy()
    // Gallery cards carry #0001-style labels
    expect(screen.getAllByText(/^#\d{4}$/).length).toBeGreaterThan(6)
    expect(screen.getByText(/counted, not/i)).toBeTruthy()
    expect(screen.getByText(/instruction accounts · in order/i)).toBeTruthy()
    // Headings may be split across elements (gradient spans), match on the container.
    expect(document.body.textContent).toMatch(/four steps,\s*one signature/i)
    expect(document.body.textContent).toMatch(/tied to\s*supply,\s*not promises/i)
  })

  it('starts in demo mode and does not claim a live broadcast', () => {
    render(<App />)
    expect(screen.getAllByText(/demo mint/i).length).toBeGreaterThan(0)
    expect(screen.getAllByText(/demo mode: transactions are simulated locally/i).length).toBeGreaterThan(0)
    expect(screen.queryByText(/confirmed on-chain and/i)).toBeNull()
  })

  it('gates the mint behind the allowlist check during the allowlist phase', async () => {
    const user = userEvent.setup()
    render(<App />)
    await connectDemoWallet(user)

    // The phase label appears in the nav chip, the timeline and the mint card.
    const phaseLabels = screen.getAllByText(/^(allowlist live|public mint live)/i)
    expect(phaseLabels.length).toBeGreaterThan(0)

    // Before verification the CTA is the allowlist gate, not the mint.
    const cta = screen.getByRole('button', { name: CTA })
    const inAllowlistPhase = phaseLabels.some((el) => /allowlist live/i.test(el.textContent ?? ''))
    if (inAllowlistPhase) {
      expect(cta.textContent).toMatch(/verify allowlist spot/i)
    } else {
      expect(cta.textContent).toMatch(/^mint \d+ fields?/i)
    }
  })
})

describe('mint flow (demo mode, end to end)', () => {
  it('connects, verifies the allowlist spot, mints and shows a receipt', async () => {
    const user = userEvent.setup()
    render(<App />)
    await connectDemoWallet(user)

    let label = await clickPrimaryCta(user)

    // During the allowlist phase the first click signs the challenge message.
    if (/verify allowlist/i.test(label)) {
      await waitFor(() => expect(screen.getByText(/allowlist spot verified/i)).toBeTruthy(), {
        timeout: 20_000,
      })
      label = await clickPrimaryCta(user)
    }

    expect(label).toMatch(/^mint \d+ fields?/i)

    // The stage machine should surface while the simulated transaction runs.
    await waitFor(
      () => {
        const running = [
          'Pre-flight checks',
          'Building transaction',
          'Approve in wallet',
          'Broadcasting',
          'Confirming on-chain',
        ].some((stage) => screen.queryByText(stage) !== null)
        const finished = document.querySelector('.receipt') !== null
        expect(running || finished).toBe(true)
      },
      { timeout: 30_000 },
    )

    await waitFor(() => expect(document.querySelector('.receipt')).toBeTruthy(), { timeout: 30_000 })

    const receipt = document.querySelector('.receipt')!
    expect(receipt.textContent).toMatch(/minted/i)
    expect(receipt.textContent).toMatch(/signature/i)
    expect(receipt.textContent).toMatch(/total paid/i)
    expect(receipt.textContent).toMatch(/simulated — nothing was broadcast/i)

    // The new field shows up in the wallet holdings panel.
    await waitFor(() => expect(screen.getByText(/1 in this wallet/i)).toBeTruthy(), {
      timeout: 10_000,
    })
  }, 90_000)

  it('surfaces a rejected signature as a failed stage, not a crash', async () => {
    const user = userEvent.setup()
    render(<App />)
    await connectDemoWallet(user)

    await user.click(screen.getByRole('button', { name: 'Open settings' }))
    const drawer = screen.getByRole('complementary', { name: 'Site settings' })
    await user.click(within(drawer).getByText('Reject wallet signatures'))
    await user.click(within(drawer).getByRole('button', { name: 'Close settings' }))

    const label = await clickPrimaryCta(user)

    if (/verify allowlist/i.test(label)) {
      await waitFor(() => expect(screen.getByText(/signature rejected|rejected in demo wallet/i)).toBeTruthy(), {
        timeout: 20_000,
      })
    } else {
      await waitFor(() => expect(screen.getByText(/rejected|failed/i)).toBeTruthy(), {
        timeout: 30_000,
      })
      expect(document.querySelector('.step--error')).toBeTruthy()
    }

    // The page is still interactive afterwards.
    expect(screen.getByRole('button', { name: 'Open settings' })).toBeTruthy()
    expect(document.querySelector('.receipt')).toBeNull()
  }, 90_000)
})

describe('settings drawer', () => {
  it('validates a program id before it can be saved', async () => {
    const user = userEvent.setup()
    render(<App />)

    await user.click(screen.getByRole('button', { name: 'Open settings' }))
    const drawer = screen.getByRole('complementary', { name: 'Site settings' })
    const input = within(drawer).getByLabelText('Mint program address') as HTMLInputElement

    await user.clear(input)
    await user.type(input, 'not-a-valid-address!')
    await waitFor(() =>
      expect(within(drawer).getByText(/must decode to 32 bytes of base58/i)).toBeTruthy(),
    )

    await user.click(within(drawer).getByRole('button', { name: /use placeholder/i }))
    await waitFor(() =>
      expect((within(drawer).getByLabelText('Mint program address') as HTMLInputElement).value).toMatch(
        /^[1-9A-HJ-NP-Za-km-z]{32,44}$/,
      ),
    )
  })

  it('switches to live mode and reports that no collection account exists', async () => {
    const user = userEvent.setup()
    render(<App />)

    await user.click(screen.getByRole('button', { name: 'Open settings' }))
    const drawer = screen.getByRole('complementary', { name: 'Site settings' })
    await user.click(within(drawer).getByRole('button', { name: 'Live' }))

    await waitFor(
      () => expect(within(drawer).getByText(/live mode reads the collection account/i)).toBeTruthy(),
      { timeout: 10_000 },
    )
    await user.click(within(drawer).getByRole('button', { name: 'Close settings' }))

    // Demo-only copy is gone once live mode is on.
    await waitFor(() => expect(screen.queryByText(/demo mint/i)).toBeNull(), { timeout: 10_000 })
  })
})
