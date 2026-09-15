import { describe, it, expect } from 'vitest'
import { readCode } from './scan'

// ============================================================================
// A full-bleed `fixed` wrapper must not swallow clicks in its own padding.
//
// components/cookie-notice.tsx is `fixed bottom-0 left-0 right-0 ... p-4`. The
// visible card inside it is max-w-2xl and centred, so the wrapper is mostly
// TRANSPARENT — and a transparent fixed element still receives pointer events.
// The result is an invisible full-width strip across the bottom of every page
// that eats clicks on whatever is underneath, for real users as much as for
// tests.
//
// It shipped that way and was only caught when a copy change made the banner
// one line taller: three e2e specs began failing with the wrapper named
// verbatim as the thing intercepting the click. Before that it cleared the
// controls beneath it by luck of layout, which is not a property anyone was
// maintaining.
//
// The fix is the pair — pointer-events-none on the wrapper, pointer-events-auto
// on the card — and it only works as a pair: the wrapper alone makes the
// dismiss button unclickable, the card alone changes nothing.
// ============================================================================

const source = readCode('components/cookie-notice.tsx')

describe('cookie notice: fixed overlay pointer events', () => {
  it('the full-bleed wrapper does not intercept pointer events', () => {
    const wrapper = /className="fixed bottom-0 left-0 right-0[^"]*"/.exec(source)?.[0]

    expect(wrapper, 'the fixed wrapper className was not found — did the layout change?')
      .toBeTruthy()
    expect(wrapper).toContain('pointer-events-none')
  })

  it('the card inside it takes them back, or nothing in the banner is clickable', () => {
    const card = /className="max-w-2xl[^"]*"/.exec(source)?.[0]

    expect(card, 'the banner card className was not found — did the layout change?')
      .toBeTruthy()
    expect(card).toContain('pointer-events-auto')
  })
})
