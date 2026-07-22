import { describe, it, expect } from 'vitest'
import { buildSponsorOnePagerPdf } from '@/lib/guidebook/sponsor-one-pager'

// A real, minimal 1x1 transparent PNG — small enough to inline, valid
// enough for pdf-lib's embedPng() to actually decode it (not a stub).
const ONE_PIXEL_PNG_BASE64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII='

function onePixelPngBytes(): ArrayBuffer {
  const buf = Buffer.from(ONE_PIXEL_PNG_BASE64, 'base64')
  return buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength)
}

function sponsor(overrides: Partial<{ business_name: string; business_description: string | null; custom_offer_text: string | null }> = {}) {
  return {
    business_name:        'Sunrise Coffee',
    business_description: 'Locally roasted coffee and pastries just up the road.',
    custom_offer_text:    '20% off for FieldStay guests',
    ...overrides,
  }
}

describe('buildSponsorOnePagerPdf', () => {
  it('produces a real PDF (magic bytes) for a fully-populated sponsor', async () => {
    const bytes = await buildSponsorOnePagerPdf(sponsor(), onePixelPngBytes(), 'https://app.fieldstay.app/g/kit/tok_abc123')

    expect(bytes.length).toBeGreaterThan(0)
    const header = Buffer.from(bytes.slice(0, 5)).toString('utf-8')
    expect(header).toBe('%PDF-')
  })

  it('succeeds when business_description is null', async () => {
    const bytes = await buildSponsorOnePagerPdf(
      sponsor({ business_description: null }),
      onePixelPngBytes(),
      'https://app.fieldstay.app/g/kit/tok_abc123'
    )

    expect(Buffer.from(bytes.slice(0, 5)).toString('utf-8')).toBe('%PDF-')
  })

  it('succeeds when custom_offer_text is null', async () => {
    const bytes = await buildSponsorOnePagerPdf(
      sponsor({ custom_offer_text: null }),
      onePixelPngBytes(),
      'https://app.fieldstay.app/g/kit/tok_abc123'
    )

    expect(Buffer.from(bytes.slice(0, 5)).toString('utf-8')).toBe('%PDF-')
  })

  it('succeeds when both optional text fields are null', async () => {
    const bytes = await buildSponsorOnePagerPdf(
      sponsor({ business_description: null, custom_offer_text: null }),
      onePixelPngBytes(),
      'https://app.fieldstay.app/g/kit/tok_abc123'
    )

    expect(Buffer.from(bytes.slice(0, 5)).toString('utf-8')).toBe('%PDF-')
  })

  it('succeeds with a long business_description that requires word-wrapping across multiple lines', async () => {
    const longDescription = 'Locally roasted coffee, fresh pastries, and a cozy reading nook. '.repeat(10)

    const bytes = await buildSponsorOnePagerPdf(
      sponsor({ business_description: longDescription }),
      onePixelPngBytes(),
      'https://app.fieldstay.app/g/kit/tok_abc123'
    )

    expect(Buffer.from(bytes.slice(0, 5)).toString('utf-8')).toBe('%PDF-')
  })

  it('produces a single-page US Letter PDF', async () => {
    const { PDFDocument } = await import('pdf-lib')
    const bytes = await buildSponsorOnePagerPdf(sponsor(), onePixelPngBytes(), 'https://app.fieldstay.app/g/kit/tok_abc123')

    const doc = await PDFDocument.load(bytes)
    expect(doc.getPageCount()).toBe(1)
    const { width, height } = doc.getPage(0).getSize()
    expect(width).toBe(612)
    expect(height).toBe(792)
  })
})
