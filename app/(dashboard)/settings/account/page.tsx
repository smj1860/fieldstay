'use client'

import { useState, useTransition } from 'react'
import { useRouter } from 'next/navigation'
import { Dialog } from '@/components/ui/Dialog'
import { Input } from '@/components/ui/Input'
import { Button } from '@/components/ui/Button'
import { InlineAlert } from '@/components/ui/InlineAlert'

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
      <div className="rounded-xl p-6" style={{ border: '1px solid var(--accent-red)' }}>
        <h2 className="text-base font-semibold mb-1" style={{ color: 'var(--accent-red)' }}>Danger Zone</h2>
        <p className="text-sm text-muted-themed mb-4">
          Permanently delete your account and all associated data. This action cannot be undone.
          If you are the organization owner, all team members must be removed first.
        </p>
        <Button variant="danger" onClick={() => setShowModal(true)}>
          Delete My Account
        </Button>
      </div>

      <Dialog
        open={showModal}
        onClose={() => { setShowModal(false); setConfirm(''); setError(null) }}
        title="Delete Account"
        maxWidthClassName="max-w-md"
      >
        <p className="text-sm text-muted-themed mb-4">
          This will permanently delete your account, cancel any active subscriptions, revoke all
          integration tokens, and erase all your data. Type <strong>DELETE</strong> to confirm.
        </p>

        {error && (
          <InlineAlert tone="error" className="mb-4">
            {error}
          </InlineAlert>
        )}

        <Input
          type="text"
          value={confirm}
          onChange={(e) => setConfirm(e.target.value)}
          placeholder="Type DELETE to confirm"
          className="mb-4 w-full"
          autoComplete="off"
        />

        <div className="flex gap-3">
          <Button
            variant="danger"
            onClick={handleDelete}
            disabled={confirm !== 'DELETE' || pending}
            className="flex-1"
          >
            {pending ? 'Deleting…' : 'Permanently Delete Account'}
          </Button>
          <Button
            variant="secondary"
            onClick={() => { setShowModal(false); setConfirm(''); setError(null) }}
            className="flex-1"
          >
            Cancel
          </Button>
        </div>
      </Dialog>
    </div>
  )
}
