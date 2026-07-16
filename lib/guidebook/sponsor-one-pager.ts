import type { PDFFont } from 'pdf-lib'
import type { GuidebookSponsor } from '@/types/database'

// Simple greedy word-wrap sized to a max pixel width at a given font/size —
// pdf-lib has no built-in text wrapping.
function wrapText(text: string, font: PDFFont, size: number, maxWidth: number): string[] {
  const words = text.split(/\s+/).filter(Boolean)
  const lines: string[] = []
  let current = ''

  for (const word of words) {
    const candidate = current ? `${current} ${word}` : word
    if (current && font.widthOfTextAtSize(candidate, size) > maxWidth) {
      lines.push(current)
      current = word
    } else {
      current = candidate
    }
  }
  if (current) lines.push(current)
  return lines
}

/**
 * Builds a printable single-page PDF sales one-pager for a guidebook sponsor
 * slot: pitch copy, the sponsor's own preview info, and a QR code linking to
 * their media kit sign-up page (/g/kit/{token}) — meant to be printed and
 * handed to a prospective local business during an in-person sponsor
 * conversation.
 *
 * Takes already-rendered QR PNG bytes (produced client-side via
 * qrcode.react's QRCodeCanvas) rather than generating the QR code itself, so
 * this can run entirely in the browser via a dynamic `import('pdf-lib')`
 * with no server round-trip and no extra QR-generation dependency.
 */
export async function buildSponsorOnePagerPdf(
  sponsor: Pick<GuidebookSponsor, 'business_name' | 'business_description' | 'custom_offer_text'>,
  qrPngBytes: ArrayBuffer,
  kitUrl: string
): Promise<Uint8Array> {
  const { PDFDocument, StandardFonts, rgb } = await import('pdf-lib')

  const NAVY  = rgb(0.055, 0.086, 0.157)
  const GOLD  = rgb(0.831, 0.647, 0.216)
  const DARK  = rgb(0.11, 0.11, 0.13)
  const GRAY  = rgb(0.42, 0.42, 0.46)
  const WHITE = rgb(1, 1, 1)

  const W  = 612  // US Letter, portrait, points
  const H  = 792
  const ML = 56
  const CW = W - ML * 2

  const pdfDoc   = await PDFDocument.create()
  const font     = await pdfDoc.embedFont(StandardFonts.Helvetica)
  const boldFont = await pdfDoc.embedFont(StandardFonts.HelveticaBold)
  const qrImage  = await pdfDoc.embedPng(qrPngBytes)

  const page = pdfDoc.addPage([W, H])

  // Header
  page.drawRectangle({ x: 0, y: H - 130, width: W, height: 130, color: NAVY })
  page.drawText('Sponsor the Guest Guidebook', { x: ML, y: H - 66, size: 24, font: boldFont, color: GOLD })
  page.drawText('Get your business in front of every guest staying nearby', {
    x: ML, y: H - 92, size: 12, font, color: WHITE,
  })

  let y = H - 170

  page.drawText(sponsor.business_name, { x: ML, y, size: 19, font: boldFont, color: DARK })
  y -= 24

  if (sponsor.business_description) {
    for (const line of wrapText(sponsor.business_description, font, 11, CW)) {
      page.drawText(line, { x: ML, y, size: 11, font, color: GRAY })
      y -= 16
    }
    y -= 8
  }

  if (sponsor.custom_offer_text) {
    for (const line of wrapText(sponsor.custom_offer_text, boldFont, 12, CW)) {
      page.drawText(line, { x: ML, y, size: 12, font: boldFont, color: GOLD })
      y -= 17
    }
    y -= 8
  }

  const pitchLines = [
    'Featured directly in the digital guidebook every guest receives at',
    'check-in — just $15/month, no contract, cancel anytime.',
  ]
  for (const line of pitchLines) {
    page.drawText(line, { x: ML, y, size: 12, font, color: DARK })
    y -= 17
  }

  // QR code + caption, centered in the lower half of the page
  const qrSize = 220
  const qrX    = (W - qrSize) / 2
  const qrY    = 150
  page.drawImage(qrImage, { x: qrX, y: qrY, width: qrSize, height: qrSize })

  const caption = 'Scan to sign up instantly'
  page.drawText(caption, {
    x: (W - boldFont.widthOfTextAtSize(caption, 13)) / 2,
    y: qrY - 22, size: 13, font: boldFont, color: DARK,
  })
  page.drawText(kitUrl, {
    x: (W - font.widthOfTextAtSize(kitUrl, 9)) / 2,
    y: qrY - 38, size: 9, font, color: GRAY,
  })

  return pdfDoc.save()
}
