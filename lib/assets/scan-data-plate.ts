import 'server-only'
import Anthropic from '@anthropic-ai/sdk'

/**
 * Shared Claude vision call for data-plate OCR — used by the synchronous PM
 * "Scan Data Plate" route (app/api/assets/scan-data-plate/route.ts) and the
 * async crew scan pipeline (lib/inngest/functions/asset-scan.ts). Keeping
 * the prompt/parsing in one place means both flows extract the same fields
 * the same way.
 */

export const SCAN_VALID_MEDIA_TYPES = ['image/jpeg', 'image/png', 'image/webp', 'image/gif'] as const
export type ScanMediaType = typeof SCAN_VALID_MEDIA_TYPES[number]

export function isValidScanMediaType(mediaType: string): mediaType is ScanMediaType {
  return (SCAN_VALID_MEDIA_TYPES as readonly string[]).includes(mediaType)
}

export interface ScanResult {
  make:             string | null
  model:            string | null
  serial_number:    string | null
  manufacture_year: number | null
  capacity:         string | null
  confidence:       'high' | 'medium' | 'low'
}

const EMPTY_RESULT: ScanResult = {
  make: null, model: null, serial_number: null,
  manufacture_year: null, capacity: null, confidence: 'low',
}

export async function scanDataPlateImage(imageBase64: string, mediaType: ScanMediaType): Promise<ScanResult> {
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
            media_type: mediaType,
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

  try {
    return JSON.parse(text) as ScanResult
  } catch {
    return EMPTY_RESULT
  }
}
