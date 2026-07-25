'use client'

import { QRCodeSVG } from 'qrcode.react'
import type { GuidebookSponsor } from '@/types/database'
import { getKitCopy, getKitLedeContext, KIT_SLOT_BAND } from '@/lib/guidebook/kit-copy'
import { GuestPhoneMock } from '../guest-phone-mock'
import styles from './print-kit.module.css'

type PrintKitSponsor = Pick<
  GuidebookSponsor,
  | 'business_name' | 'address' | 'slot_type' | 'slot_context'
  | 'offer_type' | 'offer_value' | 'offer_item' | 'custom_offer_text'
>

interface PrintKitProps {
  sponsor: PrintKitSponsor
  orgName: string | null
  kitUrl:  string
}

export function PrintKit({ sponsor, orgName, kitUrl }: Readonly<PrintKitProps>) {
  const copy = getKitCopy(sponsor.slot_type, sponsor.slot_context)
  const isNamedSlot = sponsor.slot_type !== 'general' && sponsor.slot_type !== 'other'

  const prepared = orgName
    ? `Prepared for ${sponsor.business_name} by ${orgName}`
    : sponsor.address
      ? `Prepared for ${sponsor.business_name} · ${sponsor.address}`
      : `Prepared for ${sponsor.business_name}`

  const lede = `Guests staying in our vacation rentals open a digital guidebook on their phone the moment they arrive. ${getKitLedeContext(sponsor.slot_type)}. We'd like that place to be ${sponsor.business_name}.`

  const slotTitle = isNamedSlot
    ? `The ${copy.label} spot is open — and it's yours first.`
    : 'One of only six local spots — and one is being held for you.'

  return (
    <div className={styles.pageOuter}>
      <button type="button" className={styles.printBtn} onClick={() => globalThis.print()}>
        Print / Save as PDF
      </button>

      <div className={styles.page}>
        <div className={styles.strip}>
          <div className={styles.brand}>
            FieldStay <span className={styles.brandGold}>Guidebook</span>
          </div>
          <div className={styles.prepared}>{prepared}</div>
        </div>

        <div className={styles.hero}>
          <div className={styles.heroCopy}>
            <div className={styles.eyebrow}>{copy.categoryTag}</div>
            <h1 className={styles.h1}>
              {copy.headline[0]} <em>{copy.headline[1]}</em>
            </h1>
            <p className={styles.lede}>{lede}</p>
          </div>
          <div className={styles.phoneWrap}>
            <GuestPhoneMock sponsor={sponsor} copy={copy} />
          </div>
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
          <div className={styles.slotTitle}>{slotTitle}</div>
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
          <div className={styles.math}>
            <div className={styles.big}>
              $15<small>/month</small>
            </div>
            <p>About 50¢ a day. One extra purchase a week and it pays for itself. Cancel anytime — no contract, no setup fee.</p>
          </div>
          <div className={styles.ctaGroup}>
            <div className={styles.cta}>
              Claim the {copy.label} spot
              <small>Scan to sign up — takes 2 minutes</small>
            </div>
            <div>
              <div className={styles.qrBox}>
                <QRCodeSVG value={kitUrl} size={88} />
              </div>
              <div className={styles.qrHint}>
                Scan with your
                <br />
                phone camera
              </div>
            </div>
          </div>
        </div>

        <div className={styles.foot}>
          <span>FieldStay Guest Guidebook · Local Sponsor Program</span>
          <span>fieldstay.app</span>
        </div>
      </div>
    </div>
  )
}
