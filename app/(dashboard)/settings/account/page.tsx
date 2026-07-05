'use client'

import { useState, useTransition } from 'react'
import { useRouter } from 'next/navigation'
import { Dialog } from '@/components/ui/Dialog'

export default function AccountSettingsPage() {
  const router = useRouter()
  const [showModal, setShowModal]   = useState(false)
  const [confirm, setConfirm]       = useState('')
  const [error, setError]           = useState<string | null>(null)
  const [pending, startTransition]  = useTransition()

  const handleDelete = () => {
    if (confirm !== 'DELETE') return
    setError(null)
    startTransition(async () => {
      const res = await fetch('/api/account/delete', {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ confirm: 'DELETE' }),
      })
      const data = await res.json()
      if (!res.ok) {
        setError(data.error ?? 'Failed to delete account.')
        return
      }
      router.push('/login?deleted=1')
    })
  }

  return (
    <div className="max-w-2xl mx-auto py-10 px-4">
      <h1 className="text-2xl font-bold text-primary-themed mb-1">Account</h1>
      <p className="text-sm text-muted-themed mb-10">Manage your account settings.</p>

      {/* Danger Zone */}
      <div className="border border-red-200 rounded-xl p-6">
        <h2 className="text-base font-semibold text-red-700 mb-1">Danger Zone</h2>
        <p className="text-sm text-gray-600 mb-4">
          Permanently delete your account and all associated data. This action cannot be undone.
          If you are the organization owner, all team members must be removed first.
        </p>
        <button
          onClick={() => setShowModal(true)}
          className="bg-red-600 text-white text-sm font-medium rounded-lg px-4 py-2 hover:bg-red-700 transition-colors"
        >
          Delete My Account
        </button>
      </div>

      <Dialog
        open={showModal}
        onClose={() => { setShowModal(false); setConfirm(''); setError(null) }}
        title="Delete Account"
        maxWidthClassName="max-w-md"
      >
        <p className="text-sm text-gray-600 mb-4">
          This will permanently delete your account, cancel any active subscriptions, revoke all
          integration tokens, and erase all your data. Type <strong>DELETE</strong> to confirm.
        </p>

        {error && (
          <div className="bg-red-50 border border-red-200 text-red-700 text-sm rounded-lg px-3 py-2 mb-4">
            {error}
          </div>
        )}

        <input
          type="text"
          value={confirm}
          onChange={(e) => setConfirm(e.target.value)}
          placeholder="Type DELETE to confirm"
          className="input mb-4 w-full"
          autoComplete="off"
        />

        <div className="flex gap-3">
          <button
            onClick={handleDelete}
            disabled={confirm !== 'DELETE' || pending}
            className="flex-1 bg-red-600 text-white text-sm font-medium rounded-lg px-4 py-2 hover:bg-red-700 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
          >
            {pending ? 'Deleting…' : 'Permanently Delete Account'}
          </button>
          <button
            onClick={() => { setShowModal(false); setConfirm(''); setError(null) }}
            className="flex-1 border border-gray-200 text-gray-700 text-sm font-medium rounded-lg px-4 py-2 hover:bg-gray-50 transition-colors"
          >
            Cancel
          </button>
        </div>
      </Dialog>
    </div>
  )
}
