'use client'

import { useState, useTransition } from 'react'
import { Button } from '@/components/ui/Button'
import { Card } from '@/components/ui/Card'
import { recordUnsubscribe } from './actions'

export function UnsubscribeForm({ token }: Readonly<{ token: string }>) {
  const [pending, startTransition] = useTransition()
  const [done, setDone]   = useState(false)
  const [error, setError] = useState<string | null>(null)

  function onSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault()
    setError(null)
    startTransition(async () => {
      const result = await recordUnsubscribe(token)
      if (result.ok) setDone(true)
      else setError(result.error)
    })
  }

  return (
    <main className="min-h-screen flex items-center justify-center p-6"
          style={{ background: 'var(--bg-page)' }}>
      <div className="w-full max-w-md">
        <Card>
          {done ? (
            <>
              <h1 className="text-lg font-semibold mb-2" style={{ color: 'var(--text-primary)' }}>
                You&rsquo;ve been unsubscribed
              </h1>
              <p className="text-sm" style={{ color: 'var(--text-muted)' }}>
                You will no longer receive product and marketing emails from FieldStay.
                You&rsquo;ll still get essential account messages — things like work-order
                notifications, invites, and password resets — because those are required
                to operate your account.
              </p>
            </>
          ) : (
            <form onSubmit={onSubmit}>
              <h1 className="text-lg font-semibold mb-2" style={{ color: 'var(--text-primary)' }}>
                Unsubscribe from FieldStay emails
              </h1>
              <p className="text-sm mb-6" style={{ color: 'var(--text-muted)' }}>
                This stops product and marketing emails. Essential account messages
                (work orders, invites, password resets) will still be delivered.
              </p>

              {error && (
                <p className="text-sm mb-4" role="alert" style={{ color: 'var(--accent-red)' }}>
                  {error}
                </p>
              )}

              <Button type="submit" variant="primary" disabled={pending}>
                {pending ? 'Unsubscribing…' : 'Unsubscribe'}
              </Button>
            </form>
          )}
        </Card>
      </div>
    </main>
  )
}
