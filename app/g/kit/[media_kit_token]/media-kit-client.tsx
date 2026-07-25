'use client'

import { useState } from 'react'
import { useSearchParams } from 'next/navigation'
import type { GuidebookSponsor } from '@/types/database'
import { getKitCopy, getKitLedeContext, KIT_SLOT_BAND } from '@/lib/guidebook/kit-copy'
import { GuestPhoneMock } from './guest-phone-mock'
import styles from './media-kit-client.module.css'

const GREEN = '#3F8F5C'
const RED   = '#B84B3F'
const MUTED = '#5C4A33'

interface MediaKitClientProps {
  sponsor: GuidebookSponsor
}

export function MediaKitClient({ sponsor }: Readonly<MediaKitClientProps>) {
  const searchParams = useSearchParams()
  const success       = searchParams.get('success') === 'true'
  const cancelled     = searchParams.get('cancelled') === 'true'

  const [isLoading, setIsLoading] = useState(false)
  const [error, setError]         = useState<string | null>(null)

  const isActive = sponsor.status === 'active'
  const copy = getKitCopy(sponsor.slot_type, sponsor.slot_context)
  const isNamedSlot = sponsor.slot_type !== 'general' && sponsor.slot_type !== 'other'

  const lede = `Guests staying in our vacation rentals open a digital guidebook on their phone the moment they arrive. ${getKitLedeContext(sponsor.slot_type)}. We'd like that place to be ${sponsor.business_name}.`

  async function handleCheckout() {
    setIsLoading(true)
    setError(null)

    try {
      const res = await fetch('/api/guidebook/sponsor-checkout', {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify({ mediaKitToken: sponsor.media_kit_token }),
      })

      const json = await res.json() as { url?: string; error?: string }

      if (!res.ok || !json.url) {
        setError(json.error ?? 'Something went wrong. Please try again.')
        setIsLoading(false)
        return
      }

      globalThis.location.href = json.url
    } catch {
      setError('Something went wrong. Please try again.')
      setIsLoading(false)
    }
  }

  return (
    <div className={styles.pageOuter}>
      <div className={styles.page}>
        <div className={styles.strip}>
          <div className={styles.brand}>
            FieldStay <span className={styles.brandGold}>Guidebook</span>
          </div>
        </div>

        {success && (
          <Banner color={GREEN} text="Subscription started! Your listing will appear in the guidebook shortly." />
        )}
        {cancelled && (
          <Banner color={MUTED} text="Checkout cancelled — you can try again anytime." />
        )}
        {error && <Banner color={RED} text={error} />}

        <div className={styles.eyebrow}>{copy.categoryTag}</div>
        <h1 className={styles.h1}>
          {copy.headline[0]} <em>{copy.headline[1]}</em>
        </h1>
        <p className={styles.lede}>{lede}</p>

        <div className={styles.phoneWrap}>
          <GuestPhoneMock sponsor={sponsor} copy={copy} />
        </div>

        <div className={styles.proof}>
          <div>
            <h3>No competitors next to you</h3>
            <p>We list one business per category. If you take the {copy.label} spot, no other {copy.categoryTag.toLowerCase()} business appears. Ever.</p>
          </div>
          <div>
            <h3>Shown at the right moment</h3>
            <p>{copy.proofMoment}</p>
          </div>
          <div>
            <h3>They walk in the door</h3>
            <p>One tap opens directions to you. Your perk gives them a reason to pick you over the place they found on Google.</p>
          </div>
        </div>

        <div className={styles.slotBand}>
          <div className={styles.slotTitle}>
            {isNamedSlot
              ? `The ${copy.label} spot is open — and it's yours first.`
              : 'One of only six local spots — and one is being held for you.'}
          </div>
          <div className={styles.slotSub}>Four exclusive spots per guidebook. Once each one is taken, it&apos;s taken.</div>
          <div className={styles.slots}>
            {KIT_SLOT_BAND.map((slot) => {
              const isYours = isNamedSlot && slot.slotType === sponsor.slot_type
              return (
                <div
                  key={slot.slotType}
                  className={isYours ? `${styles.slot} ${styles.slotYours}` : styles.slot}
                >
                  <div className={styles.slotName}>{slot.name}</div>
                  <div className={styles.slotTag}>{isYours ? 'Reserved for you' : slot.tag}</div>
                </div>
              )
            })}
          </div>
        </div>

        <div className={styles.close}>
          <div className={styles.big}>
            $15<small>/month</small>
          </div>
          <p className={styles.mathP}>About 50¢ a day. Cancel anytime — no contract, no setup fee.</p>

          {isActive ? (
            <Banner color={GREEN} text="This sponsorship is active. Thanks for supporting local guests!" />
          ) : (
            <button
              onClick={handleCheckout}
              disabled={isLoading}
              className={styles.cta}
            >
              {isLoading ? 'Redirecting…' : `Claim the ${copy.label} spot — $15/month`}
              <small>No contract · Cancel anytime</small>
            </button>
          )}
        </div>

        <div className={styles.foot}>FieldStay Guest Guidebook · Local Sponsor Program</div>
      </div>
    </div>
  )
}

function Banner({ color, text }: Readonly<{ color: string; text: string }>) {
  return (
    <div className={styles.banner} style={{ borderColor: color, color }}>
      {text}
    </div>
  )
}
