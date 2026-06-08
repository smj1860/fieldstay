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
import Anthropic from '@anthropic-ai/sdk'

interface ScanResponse {
  make:             string | null
  model:            string | null
  serial_number:    string | null
  manufacture_year: number | null
  capacity:         string | null
  confidence:       'high' | 'medium' | 'low'
}

export async function POST(req: Request): Promise<Response> {
  // Verify auth — any org member may scan
  await requireOrgMember()

  const { imageBase64, mediaType } = (await req.json()) as {
    imageBase64: string
    mediaType:   string
  }

  if (!imageBase64 || !mediaType) {
    return Response.json({ error: 'Missing imageBase64 or mediaType' }, { status: 400 })
  }

  const validTypes = ['image/jpeg', 'image/png', 'image/webp', 'image/gif']
  if (!validTypes.includes(mediaType)) {
    return Response.json({ error: 'Unsupported image type' }, { status: 400 })
  }

  const MAX_IMAGE_SIZE_BYTES = 5 * 1024 * 1024 // 5 MB decoded limit
  // base64 string length * 0.75 approximates decoded byte count
  const estimatedBytes = imageBase64.length * 0.75
  if (estimatedBytes > MAX_IMAGE_SIZE_BYTES) {
    return Response.json({ error: 'Image too large. Maximum 5 MB.' }, { status: 413 })
  }

  const client = new Anthropic()

  const message = await client.messages.create({
    model:      'claude-sonnet-4-6',
    max_tokens: 512,
    system:     'You return only valid JSON. No markdown, no explanation, no code fences.',
    messages: [{
      role:    'user',
      content: [
        {
          type:   'image',
          source: {
            type:       'base64',
            media_type: mediaType as 'image/jpeg' | 'image/png' | 'image/webp' | 'image/gif',
            data:       imageBase64,
          },
        },
        {
          type: 'text',
          text: `Extract from this appliance or equipment data plate:
- Manufacturer / Brand name
- Model number
- Serial number
- Manufacture year (from nameplate OR decoded from serial:
    Carrier/Bryant: chars 5-6 of serial = year
    Lennox: first 4 chars YYWW format
    Trane: position 5 = decade, position 6 = year within decade
    York: positions 2-5 encoded date
    If unknown: estimate from visual context or return null)
- Capacity / size (BTU, tons, gallons, watts, etc.)

Return ONLY this JSON (no markdown):
{
  "make": string | null,
  "model": string | null,
  "serial_number": string | null,
  "manufacture_year": number | null,
  "capacity": string | null,
  "confidence": "high" | "medium" | "low"
}`,
        },
      ],
    }],
  })

  const text = message.content[0].type === 'text' ? message.content[0].text.trim() : '{}'

  let result: ScanResponse
  try {
    result = JSON.parse(text) as ScanResponse
  } catch {
    result = {
      make: null, model: null, serial_number: null,
      manufacture_year: null, capacity: null, confidence: 'low',
    }
  }

  return Response.json(result)
}
