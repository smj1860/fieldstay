'use client'

import { useState } from 'react'
import { Copy, Check } from 'lucide-react'
import styles from './copy-button.module.css'

const BORDER = '#2A2A2E'
const MUTED  = '#9A9AA2'
const GOLD   = '#D4A537'

export function CopyButton({ value, label }: Readonly<{ value: string; label: string }>) {
  const [copied, setCopied] = useState(false)

  async function handleCopy() {
    try {
      await navigator.clipboard.writeText(value)
      setCopied(true)
      setTimeout(() => setCopied(false), 2000)
    } catch {
      // Clipboard API unavailable (older browser, non-HTTPS context) —
      // silently no-op; the value is still visible as plain text.
    }
  }

  return (
    <button
      type="button"
      onClick={handleCopy}
      aria-label={`Copy ${label}`}
      className={styles.copyBtn}
      style={{
        border: `1px solid ${BORDER}`,
        color: copied ? GOLD : MUTED,
        ...({ '--gold': GOLD } as React.CSSProperties),
      }}
    >
      {copied ? <Check className="w-3 h-3" /> : <Copy className="w-3 h-3" />}
      {copied ? 'Copied' : 'Copy'}
    </button>
  )
}
