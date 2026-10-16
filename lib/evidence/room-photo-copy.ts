// lib/evidence/room-photo-copy.ts
//
// The strings the evidence photo items carry, in a LEAF module (no imports) so
// the crew PWA can import them without pulling the server-side injection code
// in room-photos.ts into the client bundle.

export const ROOM_CONDITION_TASK = {
  en: 'Room condition photo: stand in the doorway and photograph the whole room',
  es: 'Foto del estado de la habitación: párese en la puerta y fotografíe toda la habitación',
} as const

export const ROOM_CONDITION_REASON = {
  en: 'Before and after record for this stay',
  es: 'Registro de antes y después de esta estadía',
} as const

export const EVIDENCE_SECTION    = 'Evidence photos'
export const EVIDENCE_SECTION_ES = 'Fotos de evidencia'

/** photo_reason is stored in English only (one column); render the crew locale's copy. */
export function localizedPhotoReason(locale: string, reason: string): string {
  return locale === 'es' && reason === ROOM_CONDITION_REASON.en ? ROOM_CONDITION_REASON.es : reason
}
