import 'fake-indexeddb/auto'

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { closeDashboardDb, getDashboardDb } from '@/lib/dexie/dashboard/schema'
import { draftRowId } from '@/lib/dexie/dashboard/inspection-draft'

// ============================================================================
// A PHOTOGRAPH TAKEN AT A PROPERTY WITH NO SIGNAL.
//
// The object key is decided at CAPTURE, not at upload, and that one decision is
// what lets the submit and the photo travel independently: the answer carries
// the path whether or not the bytes have landed, so a sign-off is never held
// hostage to an upload the tablet cannot complete.
//
// The other decision worth testing is atomicity. lib/dexie/photo-queue.ts keeps
// crew blobs in a SEPARATE database and its own comment records the cost — "a
// blob and its row can never be written atomically… the blob is stranded with
// nothing pointing at it", and at multiple MB each those strays push the origin
// toward evicting the whole offline cache. Here all three writes are one
// transaction.
// ============================================================================

const USER = '11111111-2222-3333-4444-555555555555'
const ORG  = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee'
const INSP = 'insp-1'
const KEY  = 'fire.a'

const uploadMock = vi.fn()

vi.mock('@/lib/images/compress', () => ({
  // Identity, so the tests are about the queue rather than about JPEG encoding.
  compressPhoto: vi.fn(async (b: Blob) => b),
}))
vi.mock('@/lib/supabase/client', () => ({
  createClient: () => ({ storage: { from: () => ({ upload: uploadMock }) } }),
}))
vi.mock('@/lib/observability/report-error', () => ({ reportError: vi.fn() }))

const {
  captureInspectionPhoto, discardInspectionPhoto, drainInspectionPhotos,
} = await import('@/lib/dexie/dashboard/inspection-photos')
const { saveAnswer } = await import('@/lib/dexie/dashboard/inspection-draft')

const photo = () => new Blob(['not-really-jpeg'], { type: 'image/jpeg' })

async function seedAnswer() {
  await saveAnswer(USER, ORG, {
    inspectionId: INSP, answerKey: KEY, formItemId: 'fi-1',
    promptSnapshot: 'Tag photo', assetId: null, repeatIndex: null,
  }, {})
}

const capture = () => captureInspectionPhoto(USER, ORG, {
  inspectionId: INSP, answerRowId: draftRowId(INSP, KEY), file: photo(),
})

beforeEach(async () => {
  uploadMock.mockReset().mockResolvedValue({ error: null })
  vi.stubGlobal('navigator', { onLine: true })

  closeDashboardDb()
  const db = getDashboardDb(USER, ORG)
  await db.open()
  await Promise.all([
    db.photo_blobs.clear(), db.pending_photo_uploads.clear(), db.inspection_answers.clear(),
  ])
  await seedAnswer()
})

afterEach(() => { vi.unstubAllGlobals() })

describe('captureInspectionPhoto', () => {
  it('writes the blob, the queue row and the answer together', async () => {
    const result = await capture()
    expect(result.ok).toBe(true)

    const db = getDashboardDb(USER, ORG)
    const path = result.path!
    expect(await db.photo_blobs.get(path)).toBeTruthy()
    expect(await db.pending_photo_uploads.get(path)).toMatchObject({
      status: 'pending', targetId: INSP, blobKey: path, failed: 0,
    })
    // One string is the blob key, the object key and the answer's photo_path,
    // so none of the three can drift from the others.
    expect((await db.inspection_answers.get(draftRowId(INSP, KEY)))!.photoPath).toBe(path)
  })

  it('the path carries the org prefix the bucket policies match on', async () => {
    // storage_org_prefix(name) reads the FIRST segment. A path without it is
    // unreachable by every policy: the upload is denied and no signed URL can
    // ever be minted for the object.
    const { path } = await capture()
    expect(path!.startsWith(`${ORG}/`)).toBe(true)
    expect(path).toMatch(new RegExp(`^${ORG}/inspections/${INSP}/[0-9a-f-]{36}\\.jpg$`))
  })

  it('two photos never collide, even on the same item', async () => {
    const a = await capture()
    const b = await capture()
    expect(a.path).not.toBe(b.path)
    expect(await getDashboardDb(USER, ORG).photo_blobs.count()).toBe(2)
  })

  it('a photo supersedes the reason there was not one', async () => {
    // Otherwise a report shows "camera failed" printed next to the photograph.
    await saveAnswer(USER, ORG, {
      inspectionId: INSP, answerKey: KEY, formItemId: 'fi-1',
      promptSnapshot: 'Tag photo', assetId: null, repeatIndex: null,
    }, { photoUnavailableReason: 'camera failed' })

    await capture()
    const row = await getDashboardDb(USER, ORG).inspection_answers.get(draftRowId(INSP, KEY))
    expect(row!.photoUnavailableReason).toBeNull()
    expect(row!.photoPath).not.toBeNull()
  })

  it('answers the Review gate immediately, not on upload', async () => {
    // The inspector has done their part the moment the shutter closes. Making
    // the gate wait for a byte transfer would block sign-off on a network the
    // whole feature exists to work without.
    uploadMock.mockRejectedValue(new TypeError('Failed to fetch'))
    const { path } = await capture()
    expect((await getDashboardDb(USER, ORG).inspection_answers.get(draftRowId(INSP, KEY)))!.photoPath)
      .toBe(path)
  })
})

describe('discardInspectionPhoto', () => {
  it('removes the bytes, the queue row and the reference', async () => {
    const { path } = await capture()
    await discardInspectionPhoto(USER, ORG, { answerRowId: draftRowId(INSP, KEY), path: path! })

    const db = getDashboardDb(USER, ORG)
    expect(await db.photo_blobs.get(path!)).toBeUndefined()
    expect(await db.pending_photo_uploads.get(path!)).toBeUndefined()
    expect((await db.inspection_answers.get(draftRowId(INSP, KEY)))!.photoPath).toBeNull()
  })
})

describe('drainInspectionPhotos', () => {
  it('uploads, keeps the row, and frees the bytes', async () => {
    const { path } = await capture()
    await drainInspectionPhotos(USER, ORG)

    const db = getDashboardDb(USER, ORG)
    // Row KEPT with its status flipped — this is why the drain is bespoke
    // rather than OutboxEngine, which deletes on success. The UI needs to tell
    // "no photo" from "photo taken, already sent".
    expect((await db.pending_photo_uploads.get(path!))!.status).toBe('uploaded')
    // Bytes gone, and only once the server has them.
    expect(await db.photo_blobs.get(path!)).toBeUndefined()
  })

  it('does nothing at all while offline', async () => {
    vi.stubGlobal('navigator', { onLine: false })
    await capture()
    await drainInspectionPhotos(USER, ORG)
    expect(uploadMock).not.toHaveBeenCalled()
  })

  it('a TRANSPORT failure costs no retry budget', async () => {
    // A drive through a dead zone would otherwise burn all five attempts on
    // "no network" and dead-letter a photograph nothing ever rejected.
    uploadMock.mockRejectedValue(new TypeError('Failed to fetch'))
    const { path } = await capture()
    for (let i = 0; i < 6; i++) await drainInspectionPhotos(USER, ORG)

    const row = await getDashboardDb(USER, ORG).pending_photo_uploads.get(path!)
    expect(row!.failed).toBeFalsy()
    expect(row!.retryCount).toBe(0)
    expect(row!.networkRetryCount).toBeGreaterThan(0)
  })

  it('keeps the bytes when the upload fails — nothing is thrown away early', async () => {
    uploadMock.mockRejectedValue(new TypeError('Failed to fetch'))
    const { path } = await capture()
    await drainInspectionPhotos(USER, ORG)
    expect(await getDashboardDb(USER, ORG).photo_blobs.get(path!)).toBeTruthy()
  })

  it('dead-letters when the BYTES are gone, rather than retrying forever', async () => {
    // Storage pressure, or a cleanup that outran its row. Nothing can recover
    // it, so the banner should say a photo was lost — which an inspector can
    // act on by retaking it.
    const { path } = await capture()
    await getDashboardDb(USER, ORG).photo_blobs.delete(path!)

    await drainInspectionPhotos(USER, ORG)

    const row = await getDashboardDb(USER, ORG).pending_photo_uploads.get(path!)
    expect(row!.failed).toBe(1)
    expect(row!.lastError).toMatch(/no longer on this device/)
    expect(uploadMock).not.toHaveBeenCalled()
  })

  it('never puts the object key in the user-facing error', async () => {
    // lastError is rendered in the sync banner. The key carries the org id and
    // the inspection id, neither of which belongs in a message a PM reads.
    const { path } = await capture()
    await getDashboardDb(USER, ORG).photo_blobs.delete(path!)
    await drainInspectionPhotos(USER, ORG)

    const row = await getDashboardDb(USER, ORG).pending_photo_uploads.get(path!)
    expect(row!.lastError).not.toContain(ORG)
    expect(row!.lastError).not.toContain(INSP)
  })

  it('an already-uploaded photo is not re-sent', async () => {
    await capture()
    await drainInspectionPhotos(USER, ORG)
    uploadMock.mockClear()

    await drainInspectionPhotos(USER, ORG)
    expect(uploadMock).not.toHaveBeenCalled()
  })

  it('upserts, so a replay cannot 409 on its own earlier attempt', async () => {
    await capture()
    await drainInspectionPhotos(USER, ORG)
    expect(uploadMock.mock.calls[0]![2]).toMatchObject({ upsert: true })
  })
})
