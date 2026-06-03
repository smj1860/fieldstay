'use client'

import { useState, useEffect } from 'react'
import Link from 'next/link'

const STORAGE_KEY = 'fs-cookie-consent'

export function CookieConsent() {
  const [visible, setVisible] = useState(false)

  useEffect(() => {
    try {
      if (!localStorage.getItem(STORAGE_KEY)) setVisible(true)
    } catch {
      // localStorage unavailable — don't show banner
    }
  }, [])

  const accept = () => {
    try { localStorage.setItem(STORAGE_KEY, 'accepted') } catch { /* noop */ }
    setVisible(false)
  }

  if (!visible) return null

  return (
    <div className="fixed bottom-0 inset-x-0 z-50 p-4 flex justify-center">
      <div className="bg-white border border-gray-200 rounded-xl shadow-lg max-w-xl w-full flex items-center justify-between gap-4 px-5 py-4">
        <p className="text-sm text-gray-600">
          We use essential cookies to keep you signed in.{' '}
          <Link href="/privacy" className="underline text-gray-800 hover:text-gray-900">
            Privacy Policy
          </Link>
        </p>
        <button
          onClick={accept}
          className="flex-shrink-0 bg-gray-900 text-white text-sm font-medium rounded-lg px-4 py-2 hover:bg-gray-700 transition-colors"
        >
          Got it
        </button>
      </div>
    </div>
  )
}
