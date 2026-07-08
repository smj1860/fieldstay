import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, act } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { InstallBanner } from '@/components/pwa/install-banner'

const IPHONE_SAFARI_UA =
  'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1'
const CHROME_ANDROID_UA =
  'Mozilla/5.0 (Linux; Android 14) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Mobile Safari/537.36'

function mockUserAgent(ua: string) {
  vi.spyOn(window.navigator, 'userAgent', 'get').mockReturnValue(ua)
}

function mockMatchMedia(standalone: boolean) {
  vi.stubGlobal(
    'matchMedia',
    vi.fn().mockImplementation((query: string) => ({
      matches: standalone && query === '(display-mode: standalone)',
      media: query,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    }))
  )
}

class FakeBeforeInstallPromptEvent extends Event {
  outcome: 'accepted' | 'dismissed'
  constructor(outcome: 'accepted' | 'dismissed' = 'accepted') {
    super('beforeinstallprompt', { cancelable: true })
    this.outcome = outcome
  }
  prompt = vi.fn().mockResolvedValue(undefined)
  get userChoice() {
    return Promise.resolve({ outcome: this.outcome })
  }
}

describe('InstallBanner', () => {
  beforeEach(() => {
    localStorage.clear()
    mockMatchMedia(false)
    mockUserAgent(CHROME_ANDROID_UA)
  })

  afterEach(() => {
    vi.restoreAllMocks()
    vi.unstubAllGlobals()
  })

  it('renders nothing when already running as an installed PWA', () => {
    mockMatchMedia(true)
    render(<InstallBanner />)

    expect(screen.queryByText(/Install FieldStay/)).not.toBeInTheDocument()
    expect(screen.queryByText(/Add to Home Screen/)).not.toBeInTheDocument()
  })

  it('renders nothing when recently dismissed', () => {
    localStorage.setItem('pwa-install-dismissed-at', String(Date.now()))
    render(<InstallBanner />)

    expect(screen.queryByText(/Install FieldStay/)).not.toBeInTheDocument()
  })

  it('shows iOS instructions on iOS Safari, and dismiss hides + persists', async () => {
    mockUserAgent(IPHONE_SAFARI_UA)
    render(<InstallBanner />)

    expect(screen.getByText('Add to Home Screen')).toBeInTheDocument()

    await userEvent.click(screen.getByRole('button', { name: 'Dismiss install prompt' }))

    expect(screen.queryByText('Add to Home Screen')).not.toBeInTheDocument()
    expect(localStorage.getItem('pwa-install-dismissed-at')).not.toBeNull()
  })

  it('renders nothing on a generic browser until beforeinstallprompt fires, then shows the Android banner', async () => {
    render(<InstallBanner />)

    expect(screen.queryByText(/Install FieldStay/)).not.toBeInTheDocument()

    act(() => {
      window.dispatchEvent(new FakeBeforeInstallPromptEvent('accepted'))
    })

    expect(await screen.findByText('Install FieldStay')).toBeInTheDocument()
  })

  it('calls prompt() and hides on accepted install', async () => {
    render(<InstallBanner />)

    const event = new FakeBeforeInstallPromptEvent('accepted')
    act(() => {
      window.dispatchEvent(event)
    })
    await screen.findByText('Install FieldStay')

    await userEvent.click(screen.getByRole('button', { name: 'Install' }))

    expect(event.prompt).toHaveBeenCalledTimes(1)
    expect(screen.queryByText('Install FieldStay')).not.toBeInTheDocument()
  })

  it('dismisses (without persisting a decline as an install) on a rejected prompt', async () => {
    render(<InstallBanner />)

    const event = new FakeBeforeInstallPromptEvent('dismissed')
    act(() => {
      window.dispatchEvent(event)
    })
    await screen.findByText('Install FieldStay')

    await userEvent.click(screen.getByRole('button', { name: 'Install' }))

    expect(screen.queryByText('Install FieldStay')).not.toBeInTheDocument()
    expect(localStorage.getItem('pwa-install-dismissed-at')).not.toBeNull()
  })
})
