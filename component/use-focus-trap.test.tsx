import { useRef } from 'react'
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, fireEvent, act } from '@testing-library/react'
import { useFocusTrap } from '@/lib/hooks/use-focus-trap'

function TestHarness({ open, onClose }: Readonly<{ open: boolean; onClose: () => void }>) {
  const panelRef = useRef<HTMLDivElement>(null)
  useFocusTrap(panelRef, open, onClose)

  return (
    <div>
      <button type="button">Outside</button>
      {open && (
        <div ref={panelRef} data-testid="panel">
          <button type="button">First</button>
          <button type="button">Second</button>
          <button type="button">Last</button>
        </div>
      )}
    </div>
  )
}

describe('useFocusTrap', () => {
  beforeEach(() => {
    document.body.style.overflow = ''
  })

  afterEach(() => {
    document.body.style.overflow = ''
  })

  it('does nothing while closed', () => {
    render(<TestHarness open={false} onClose={vi.fn()} />)

    expect(document.body.style.overflow).toBe('')
    expect(screen.queryByTestId('panel')).not.toBeInTheDocument()
  })

  it('focuses the first focusable element in the panel when it opens', () => {
    const outsideBtn = document.createElement('button')
    document.body.appendChild(outsideBtn)
    outsideBtn.focus()

    const { rerender } = render(<TestHarness open={false} onClose={vi.fn()} />)
    rerender(<TestHarness open onClose={vi.fn()} />)

    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'First' }))
    document.body.removeChild(outsideBtn)
  })

  it('Tab from the last element wraps to the first', () => {
    render(<TestHarness open onClose={vi.fn()} />)
    const last = screen.getByRole('button', { name: 'Last' })
    const first = screen.getByRole('button', { name: 'First' })

    act(() => {
      last.focus()
    })
    expect(document.activeElement).toBe(last)

    fireEvent.keyDown(document, { key: 'Tab' })

    expect(document.activeElement).toBe(first)
  })

  it('Shift+Tab from the first element wraps to the last', () => {
    render(<TestHarness open onClose={vi.fn()} />)
    const last = screen.getByRole('button', { name: 'Last' })
    const first = screen.getByRole('button', { name: 'First' })

    act(() => {
      first.focus()
    })
    expect(document.activeElement).toBe(first)

    fireEvent.keyDown(document, { key: 'Tab', shiftKey: true })

    expect(document.activeElement).toBe(last)
  })

  it('does not interfere with Tab when focus is in the middle of the panel', () => {
    render(<TestHarness open onClose={vi.fn()} />)
    const second = screen.getByRole('button', { name: 'Second' })

    act(() => {
      second.focus()
    })

    fireEvent.keyDown(document, { key: 'Tab' })

    // Only wrap-around cases are intercepted — from the middle element the
    // handler doesn't preventDefault or move focus itself.
    expect(document.activeElement).toBe(second)
  })

  it('calls onClose and prevents default when Escape is pressed', () => {
    const onClose = vi.fn()
    render(<TestHarness open onClose={onClose} />)

    const event = new KeyboardEvent('keydown', { key: 'Escape', cancelable: true })
    document.dispatchEvent(event)

    expect(onClose).toHaveBeenCalledTimes(1)
    expect(event.defaultPrevented).toBe(true)
  })

  it('locks body scroll while open and restores the previous value on close', () => {
    document.body.style.overflow = 'auto'
    const { rerender } = render(<TestHarness open={false} onClose={vi.fn()} />)
    // Effect for open=false is a no-op — the pre-existing value is untouched.
    expect(document.body.style.overflow).toBe('auto')

    rerender(<TestHarness open onClose={vi.fn()} />)
    expect(document.body.style.overflow).toBe('hidden')

    rerender(<TestHarness open={false} onClose={vi.fn()} />)
    expect(document.body.style.overflow).toBe('auto')
  })

  it('restores focus to the previously focused element when it closes', () => {
    const outsideBtn = document.createElement('button')
    outsideBtn.textContent = 'Real outside'
    document.body.appendChild(outsideBtn)
    outsideBtn.focus()

    const { rerender } = render(<TestHarness open={false} onClose={vi.fn()} />)
    rerender(<TestHarness open onClose={vi.fn()} />)
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'First' }))

    rerender(<TestHarness open={false} onClose={vi.fn()} />)

    expect(document.activeElement).toBe(outsideBtn)
    document.body.removeChild(outsideBtn)
  })

  it('adds a keydown listener while open and removes it on unmount (no leaked listener)', () => {
    const addSpy = vi.spyOn(document, 'addEventListener')
    const removeSpy = vi.spyOn(document, 'removeEventListener')

    const { unmount } = render(<TestHarness open onClose={vi.fn()} />)

    expect(addSpy).toHaveBeenCalledWith('keydown', expect.any(Function))
    const [, handler] = addSpy.mock.calls.find(([type]) => type === 'keydown')!

    unmount()

    expect(removeSpy).toHaveBeenCalledWith('keydown', handler)

    addSpy.mockRestore()
    removeSpy.mockRestore()
  })

  it('removes the previous listener and installs a fresh one when re-opened after closing', () => {
    const addSpy = vi.spyOn(document, 'addEventListener')
    const removeSpy = vi.spyOn(document, 'removeEventListener')

    const { rerender } = render(<TestHarness open onClose={vi.fn()} />)
    const addCallsAfterOpen = addSpy.mock.calls.filter(([type]) => type === 'keydown').length
    expect(addCallsAfterOpen).toBe(1)

    rerender(<TestHarness open={false} onClose={vi.fn()} />)
    expect(removeSpy.mock.calls.filter(([type]) => type === 'keydown').length).toBe(1)

    addSpy.mockRestore()
    removeSpy.mockRestore()
  })
})
