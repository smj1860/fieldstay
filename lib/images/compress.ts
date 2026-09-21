// lib/images/compress.ts
//
// Downscale and re-compress a camera photo before it is stored or uploaded.
//
// WHY IT LIVES HERE AND NOT IN lib/dexie/
//
// It started in lib/dexie/photo-queue.ts because the crew PWA needed it first,
// and it stayed there long enough to look like part of the sync layer. It is
// not: Blob in, Blob out, no IndexedDB, no outbox, no cursors, nothing that
// knows Dexie exists.
//
// The move was forced by the inspections work. docs/INSPECTIONS_SPEC.md §4 puts
// inspections deliberately OUTSIDE lib/dexie/* so the four crew guardrails keep
// meaning what they say, and importing a helper across that boundary would
// erode exactly the line that rule draws. The alternative — a second copy —
// is worse and would be invisible, because both copies would work. Two copies
// of a resize threshold that drift into two different answers is the defect
// class this codebase pays for most often.
//
// So: share the rule, not the table. Same principle §4 states, applied to §4.
//
// SYNCHRONOUS ON PURPOSE, FOR NOW — a Worker migration is real follow-up work,
// not done here. The 2026-09-16 scalability audit flagged this canvas work as
// blocking the main thread per photo. Every call site today (grep
// `compressPhoto` — the crew turnover photo/section-photo capture handlers,
// the discovery-capture modal, the inspection and vendor-WO photo sync paths)
// invokes this from a SINGLE file-input `change`/capture event, one photo at
// a time — there is no existing loop that compresses several photos back to
// back in one synchronous burst, so `requestIdleCallback`-chunking a sequence
// has no real call site to attach to yet. If a batch-capture flow is added
// later, revisit this file first rather than assuming the single-photo cost
// is representative.
//
// A real Worker + OffscreenCanvas offload was scoped out of THIS pass
// deliberately rather than shipped half-verified: this repo has no existing
// Worker-building convention to follow, and image-compression correctness
// bugs (wrong orientation, a dropped alpha channel, a canvas that silently
// taints) are exactly the class that passes a unit test and fails on a real
// crew phone — which is where the crew PWA actually runs (see the module
// header above). Landing that without device testing would trade a known,
// bounded main-thread stall for an unverified correctness risk. The path,
// if picked up: an OffscreenCanvas worker script that mirrors the resize/
// encode logic below exactly, postMessage the source Blob in and the
// compressed Blob (or an error) back out, and keep this synchronous
// implementation as the fallback for browsers without OffscreenCanvas/Worker
// transferable-Blob support (some crew devices in the field are older
// Android/iOS Safari versions) — never remove it outright.

/**
 * Downscales and re-compresses a camera photo.
 *
 * Full-resolution camera photos (3–8MB+ on modern phones and tablets) queued
 * uncompressed across a multi-item checklist can exhaust the IndexedDB quota,
 * especially under iOS Safari's more aggressive eviction. 1600px longest edge
 * at JPEG quality 0.75 is well beyond what a verification photo needs to be
 * useful to whoever reviews it.
 *
 * FALLS BACK TO THE ORIGINAL on any failure, which is a deliberate trade and
 * worth understanding before relying on it. For a crew checklist it is plainly
 * right: a codec quirk must not block someone's work. For a long inspection it
 * is a WEAKER guarantee than it looks — twenty uncompressed originals held in
 * IndexedDB until reconnect is the exact case iOS eviction takes, so a caller
 * in that position should treat a fallback as a signal rather than a shrug.
 */
export async function compressPhoto(
  file: Blob,
  maxDimension = 1600,
  quality = 0.75,
): Promise<Blob> {
  try {
    const bitmap = await createImageBitmap(file)
    const scale  = Math.min(1, maxDimension / Math.max(bitmap.width, bitmap.height))
    const width  = Math.round(bitmap.width  * scale)
    const height = Math.round(bitmap.height * scale)

    const canvas = document.createElement('canvas')
    canvas.width  = width
    canvas.height = height
    const ctx = canvas.getContext('2d')
    if (!ctx) {
      bitmap.close()
      return file // no 2d context available — fall back to the original
    }

    ctx.drawImage(bitmap, 0, 0, width, height)
    bitmap.close()

    const blob = await new Promise<Blob | null>((resolve) =>
      canvas.toBlob(resolve, 'image/jpeg', quality)
    )
    return blob ?? file
  } catch (err) {
    // Non-fatal — compression is a size optimization, not a correctness
    // requirement. Fall back to the original file rather than blocking the
    // user's progress on a canvas/codec quirk.
    console.warn('[images] compression failed, storing original:', err)
    return file
  }
}
