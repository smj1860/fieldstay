/**
 * Data Plate OCR — POST /api/assets/scan-data-plate
 *
 * Accepts a base64-encoded appliance/equipment data plate photo,
 * sends to Claude for structured extraction, returns JSON with:
 * { make, model, serial_number, manufacture_year, capacity, confidence }
 *
 * Called from the mobile asset form "Scan Data Plate" button.
 * Auth is verified via the Supabase session cookie.
 */

import 'server-only'
import { requireOrgMember } from '@/lib/auth'
import { scanLimiter } from '@/lib/rate-limit'
import { scanDataPlateImage, isValidScanMediaType } from '@/lib/assets/scan-data-plate'

export const maxDuration = 60  // vision calls can run longer than text-only LLM calls

export async function POST(req: Request): Promise<Response> {
  // Verify auth — any org member may scan
  const { user } = await requireOrgMember()

  // Rate limit — 20 scans per user per day
  const { success } = await scanLimiter.limit(user.id)
  if (!success) {
    return Response.json({ error: 'Daily scan limit reached. Try again tomorrow.' }, { status: 429 })
  }

  const { imageBase64, mediaType } = (await req.json()) as {
    imageBase64: string
    mediaType:   string
  }

  if (!imageBase64 || !mediaType) {
    return Response.json({ error: 'Missing imageBase64 or mediaType' }, { status: 400 })
  }

  if (!isValidScanMediaType(mediaType)) {
    return Response.json({ error: 'Unsupported image type' }, { status: 400 })
  }

  const MAX_IMAGE_SIZE_BYTES = 5 * 1024 * 1024 // 5 MB decoded limit
  // base64 string length * 0.75 approximates decoded byte count
  const estimatedBytes = imageBase64.length * 0.75
  if (estimatedBytes > MAX_IMAGE_SIZE_BYTES) {
    return Response.json({ error: 'Image too large. Maximum 5 MB.' }, { status: 413 })
  }

  const result = await scanDataPlateImage(imageBase64, mediaType)

  return Response.json(result)
}
