import type { GuidebookSponsor } from '@/types/database'
import { formatOffer } from '@/lib/guidebook/offer'
import type { KitSlotCopy } from '@/lib/guidebook/kit-copy'
import styles from './guest-phone-mock.module.css'

type GuestPhoneMockSponsor = Pick<
  GuidebookSponsor,
  'business_name' | 'address' | 'offer_type' | 'offer_value' | 'offer_item' | 'custom_offer_text'
>

interface GuestPhoneMockProps {
  sponsor: GuestPhoneMockSponsor
  copy:    KitSlotCopy
}

/**
 * The "what guests actually see" phone mockup shared by the print kit and
 * the sponsor signup page — same markup/data, different surrounding layout.
 */
export function GuestPhoneMock({ sponsor, copy }: Readonly<GuestPhoneMockProps>) {
  const perkLine =
    formatOffer(sponsor.offer_type, sponsor.offer_value, sponsor.offer_item, sponsor.custom_offer_text) ??
    sponsor.custom_offer_text

  return (
    <div className={styles.phone}>
      <div className={styles.screen}>
        <div className={styles.phTime}>
          <span>{copy.mockTime}</span>
          <span>{copy.mockWeather}</span>
        </div>
        <div className={styles.moment}>{copy.momentChip}</div>
        <div className={styles.card}>
          <div className={styles.label}>{copy.cardLabel}</div>
          <div className={styles.name}>{sponsor.business_name}</div>
          {sponsor.address && <div className={styles.addr}>{sponsor.address}</div>}
          {perkLine && <div className={styles.perk}>{perkLine}</div>}
          <div className={styles.btn}>Get directions</div>
        </div>
      </div>
      <div className={styles.caption}>What guests actually see — with you in it.</div>
    </div>
  )
}
