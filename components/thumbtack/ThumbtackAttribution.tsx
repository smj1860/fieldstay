import Image from 'next/image'

// ============================================================================
// Thumbtack's Do's & Don'ts: "Attribute all content originated from the API
// to Thumbtack using 'Listed by Thumbtack' or 'Powered by Thumbtack'" and
// "Use logos and wordmark other than what's provided" is a Don't — so this
// renders their actual icon asset (public/thumbtack-icon.jpg, from their
// media resources), never a redrawn or recolored version.
//
// The asset is an opaque JPEG (solid white background baked into the pixels,
// no transparency) — the SAME situation app/hospitable/page.tsx's partner
// badge already solved. Same fix: a small white pill behind it, so the white
// background reads as a deliberate badge rather than a transparency bug on
// FieldStay's dark cards.
// ============================================================================

export function ThumbtackAttribution({ label = 'Powered by Thumbtack' }: Readonly<{ label?: string }>) {
  return (
    <div className="flex items-center gap-1.5">
      <span className="bg-white rounded-full p-0.5 flex items-center justify-center flex-shrink-0" style={{ width: 16, height: 16 }}>
        <Image src="/thumbtack-icon.jpg" alt="" width={32} height={32} className="w-full h-full object-contain rounded-full" />
      </span>
      <span className="text-[10px]" style={{ color: 'var(--text-muted)' }}>{label}</span>
    </div>
  )
}
