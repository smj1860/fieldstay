import { describe, it, expect } from 'vitest'
import { createElement } from 'react'
import { renderToString } from 'react-dom/server'
import { Dialog } from '@/components/ui/Dialog'

// Node environment: no `document`. A Dialog open on its first render (a
// `?connect=hostaway` deep link) must not throw during server rendering.
describe('Dialog server rendering', () => {
  it('does not throw when open on first render without a DOM', () => {
    expect(typeof document).toBe('undefined')
    const props = { open: true, onClose: () => {}, title: 'T', children: 'body' }
    const render = () => renderToString(createElement(Dialog, props))
    expect(render).not.toThrow()
    expect(render()).not.toContain('body')
  })
})
