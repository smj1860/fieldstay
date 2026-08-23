'use client'

// The tablet fill screen.
//
// ─────────────────────────────────────────────────────────────────────────────
// THE LAYOUT, AND THE THREE DECISIONS BEHIND IT
//
// Section per page, with Back and Next at the bottom.
//
//   1. NEXT IS NAVIGATION ONLY, AND IS NEVER BLOCKED. A walk is not linear: the
//      utility room is locked, the inspector moves on and comes back. A pager
//      that refuses to advance until the page is complete fights the job rather
//      than the mistake, and what it actually produces is a tapped-through
//      answer to get past the gate — a worse record than a blank.
//   2. AN INDEX, SO ANY PAGE IS ONE TAP AWAY. The direct consequence of (1):
//      without it an unblocked Next is a one-way door, and the only route back
//      to a skipped section is Back, eight times.
//   3. THE REVIEW PAGE IS MANDATORY BEFORE SIGN-OFF MARKS IT COMPLETE. This is
//      where (1)'s cost is paid. Sign-off is the one control that blocks,
//      because what it produces is a certification: a signed declaration that
//      "all verified items meet standard operational safety guidelines" over a
//      form with eleven blanks is not an incomplete record, it is a false one.
//
// ─────────────────────────────────────────────────────────────────────────────
// EVERYTHING RENDERS FROM DEXIE, INCLUDING WHEN ONLINE
//
// Not an optimisation — the condition public/sw.js sets for /maintenance
// joining the offline allowlist: "it goes in when it renders from the local
// cache, not when the local cache exists." A screen that reads from the network
// when it can and the cache when it cannot has two code paths, and the offline
// one is the one nobody exercises. This has one.

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useLiveQuery } from 'dexie-react-hooks'
import { ChevronLeft, ChevronRight, Clock, List, WifiOff } from 'lucide-react'

import { Button } from '@/components/ui/Button'
import { Card } from '@/components/ui/Card'
import {
  answerKey,
  findOutstanding,
  pageProgress,
  resolveFormPages,
  visibleNodes,
} from '@/lib/inspections/resolve-form'
import { formFromSnapshot, parseFormSnapshot } from '@/lib/inspections/snapshots'
import { getDashboardDb } from '@/lib/dexie/dashboard/schema'
import {
  draftRowId,
  pruneFinishedInspections,
  saveAnswer,
  toAnswerStates,
  toCountsByItemId,
  type AnswerPatch,
} from '@/lib/dexie/dashboard/inspection-draft'
import { pullInspection } from '@/lib/dexie/dashboard/inspection-sync'
import {
  captureInspectionPhoto,
  discardInspectionPhoto,
  drainInspectionPhotos,
} from '@/lib/dexie/dashboard/inspection-photos'
import type { InspectionAnswerRow } from '@/lib/dexie/dashboard/schema'
import { enqueueDashboardMutation } from '@/lib/dexie/dashboard/syncService'
import type { PropertyAsset } from '@/types/database'

import { ItemRow } from './item-row'
import { ReviewPage } from './review-page'
import { SectionIndex } from './section-index'

interface Props {
  inspectionId: string
  userId:       string
  orgId:        string
}

export function FillScreen({ inspectionId, userId, orgId }: Readonly<Props>) {
  const [stop, setStop]               = useState(0)
  const [indexOpen, setIndexOpen]     = useState(false)
  const [inspectorName, setInspectorName] = useState('')
  const [pullFailed, setPullFailed]   = useState(false)
  const [submitError, setSubmitError] = useState<string | null>(null)
  const [submitting, setSubmitting]   = useState(false)

  // Pull on mount, then render from the cache regardless of how it went. A
  // failed pull is the expected state at a property and changes nothing about
  // whether the inspector can work — it only matters if the cache is ALSO
  // empty, which is what the guard further down distinguishes.
  useEffect(() => {
    let cancelled = false
    void pullInspection(userId, orgId, inspectionId).then((outcome) => {
      if (!cancelled) setPullFailed(!outcome.ok)
    })
    void pruneFinishedInspections(userId, orgId)
    // Any photo left queued from a previous visit — the drain is idempotent and
    // gates itself on being online.
    void drainInspectionPhotos(userId, orgId)

    const onOnline = () => { void drainInspectionPhotos(userId, orgId) }
    globalThis.addEventListener?.('online', onOnline)
    return () => { cancelled = true; globalThis.removeEventListener?.('online', onOnline) }
  }, [userId, orgId, inspectionId])

  const db = useMemo(() => getDashboardDb(userId, orgId), [userId, orgId])

  const inspection = useLiveQuery(() => db.inspections.get(inspectionId), [db, inspectionId])
  const answerRows = useLiveQuery(
    () => db.inspection_answers.where('inspectionId').equals(inspectionId).toArray(),
    [db, inspectionId],
    [],
  )
  // Whether a sign-off is already queued. Derived from the outbox rather than
  // held as a local flag: the flag and the queue could disagree, and the queue
  // is the one that decides whether the work actually gets sent.
  const queuedSubmit = useLiveQuery(
    () => db.mutations.where('[kind+targetId]')
      .equals(['inspection.submit', inspectionId]).first(),
    [db, inspectionId],
  )

  const assets = useLiveQuery(
    // `async` so both branches produce the same Promise type. A bare ternary
    // yields `PromiseExtended<PropertyAsset[]> | Promise<never[]>`, and the
    // never[] arm poisons the inferred result.
    async (): Promise<PropertyAsset[]> => (inspection
      ? db.property_assets.where('property_id').equals(inspection.property_id).toArray()
      : []),
    [db, inspection?.property_id],
    [] as PropertyAsset[],
  )

  const snapshot = useMemo(
    () => (inspection ? parseFormSnapshot(inspection.form_snapshot) : null),
    [inspection],
  )

  const answers   = useMemo(() => toAnswerStates(answerRows ?? []), [answerRows])
  const answersById = useMemo(
    () => new Map((answerRows ?? []).map((r) => [r.answerKey, r])),
    [answerRows],
  )

  const pages = useMemo(() => {
    if (!snapshot) return []
    return resolveFormPages({
      ...formFromSnapshot(snapshot),
      assets:         assets ?? [],
      countsByItemId: toCountsByItemId(answerRows ?? []),
    })
  }, [snapshot, assets, answerRows])

  const outstanding = useMemo(() => findOutstanding(pages, answers), [pages, answers])

  const onChange = useCallback((key: string, formItemId: string, prompt: string,
                                assetId: string | null, repeatIndex: number | null,
                                patch: AnswerPatch) => {
    void saveAnswer(userId, orgId, {
      inspectionId, answerKey: key, formItemId,
      promptSnapshot: prompt, assetId, repeatIndex,
    }, patch)
  }, [userId, orgId, inspectionId])

  // When the queued submit DISAPPEARS, the drain accepted it — the outbox
  // deletes a row only after its handler resolves. The server now has
  // completed_at and the cached row does not, so without this the screen would
  // flip straight back to an editable form over answers that are already filed.
  const hadQueuedSubmit = useRef(false)
  useEffect(() => {
    if (queuedSubmit) { hadQueuedSubmit.current = true; return }
    if (!hadQueuedSubmit.current) return
    hadQueuedSubmit.current = false
    void pullInspection(userId, orgId, inspectionId)
  }, [queuedSubmit, userId, orgId, inspectionId])

  const signOff = useCallback(async () => {
    setSubmitError(null)
    setSubmitting(true)
    try {
      const rows = await db.inspection_answers.where('inspectionId').equals(inspectionId).toArray()
      if (rows.length === 0) {
        setSubmitError('There are no answers to submit.')
        return
      }

      // QUEUED, not POSTed directly. Sign-off has to work in the basement where
      // the walk happened, and the outbox already carries the offline gate,
      // backoff and dead-lettering the crew surface paid for.
      await enqueueDashboardMutation(userId, orgId, {
        kind:     'inspection.submit',
        targetId: inspectionId,
        payload:  { inspectorName: inspectorName.trim(), items: rows.map(toSubmittedItem) },
      })
    } catch (err) {
      console.error('[inspection.signOff]', err)
      setSubmitError('Could not queue the submission. Please try again.')
    } finally {
      setSubmitting(false)
    }
  }, [db, userId, orgId, inspectionId, inspectorName])


  /**
   * A captured image. The answer row must EXIST before the photo can attach to
   * it, so an untouched item gets one created first — the same merge-on-write
   * saveAnswer does for every other control.
   */
  const onCapture = useCallback(async (key: string, file: Blob) => {
    const node = pages.flatMap((p) => visibleNodes(p, answers)).find((n) => answerKey(n.item) === key)
    if (!node) return

    await saveAnswer(userId, orgId, {
      inspectionId, answerKey: key, formItemId: node.item.formItem.id,
      promptSnapshot: node.item.formItem.prompt,
      assetId: node.item.asset?.id ?? null, repeatIndex: node.item.repeatIndex ?? null,
    }, {})

    const result = await captureInspectionPhoto(userId, orgId, {
      inspectionId, answerRowId: draftRowId(inspectionId, key), file,
    })
    if (!result.ok) setSubmitError(result.error ?? 'Could not save that photo.')
  }, [userId, orgId, inspectionId, pages, answers])

  const onDiscard = useCallback(async (key: string) => {
    const row = answersById.get(key)
    if (!row?.photoPath) return
    await discardInspectionPhoto(userId, orgId, {
      answerRowId: draftRowId(inspectionId, key), path: row.photoPath,
    })
  }, [userId, orgId, inspectionId, answersById])

  // ── Loading and failure states, kept apart ────────────────────────────────
  //
  // `undefined` from useLiveQuery is "the query has not resolved", which is not
  // the same as "there is no such row". Collapsing them would show a hard error
  // for the first frame of every load.
  if (inspection === undefined) {
    return <Shell><p className="text-sm" style={{ color: 'var(--text-muted)' }}>Loading…</p></Shell>
  }

  if (!inspection) {
    return (
      <Shell>
        <Card>
          <p className="text-sm" style={{ color: 'var(--text-primary)' }}>
            {pullFailed
              ? 'This inspection isn’t on this device yet, and there’s no connection to fetch it. Reconnect and open it again.'
              : 'That inspection could not be found.'}
          </p>
        </Card>
      </Shell>
    )
  }

  if (!snapshot) {
    // A malformed snapshot is not a shorter form — parseFormSnapshot refuses to
    // drop sections precisely so this shows as a failure rather than as an
    // inspection that looks complete with a section missing.
    return (
      <Shell>
        <Card>
          <p className="text-sm" style={{ color: 'var(--accent-red)' }}>
            This inspection’s form could not be read, so it cannot be filled in safely.
            Please report this rather than starting again.
          </p>
        </Card>
      </Shell>
    )
  }

  if (inspection.completed_at) {
    return (
      <Shell>
        <Card>
          <p className="text-sm" style={{ color: 'var(--text-primary)' }}>
            This inspection was completed on {new Date(inspection.completed_at).toLocaleDateString()}
            {inspection.inspector_name ? ` by ${inspection.inspector_name}` : ''}. Completed
            inspections are immutable — a correction is a new inspection, not an edit.
          </p>
        </Card>
      </Shell>
    )
  }

  // A queued submit makes the form read-only, and that is not cosmetic: the
  // payload was SNAPSHOTTED at enqueue, so an edit made now would look saved on
  // screen and never be sent.
  if (queuedSubmit) {
    return (
      <Shell>
        <QueuedSubmitPanel
          failed={!!queuedSubmit.failed}
          lastError={queuedSubmit.lastError}
          signedBy={inspection.inspector_name ?? inspectorName.trim()}
        />
      </Shell>
    )
  }


  const onReview = stop >= pages.length
  const page     = onReview ? null : pages[stop]

  return (
    <Shell>
      {pullFailed && (
        <p className="flex items-center gap-1.5 text-xs" style={{ color: 'var(--text-muted)' }}>
          <WifiOff className="w-3.5 h-3.5" />
          Working offline. Answers are saved on this device and sent at sign-off.
        </p>
      )}

      <div className="flex items-center justify-between gap-3">
        <h1 className="text-lg font-bold truncate" style={{ color: 'var(--text-primary)' }}>
          {onReview ? 'Review & sign off' : page!.name}
        </h1>
        <Button variant="secondary" onClick={() => setIndexOpen(true)} className="flex items-center gap-1.5 shrink-0">
          <List className="w-4 h-4" />
          {onReview ? 'Review' : `${stop + 1}/${pages.length}`}
        </Button>
      </div>

      {onReview ? (
        <ReviewPage
          outstanding={outstanding}
          inspectorName={inspectorName}
          onInspectorNameChange={setInspectorName}
          onGoToPage={setStop}
          onSignOff={() => { void signOff() }}
          submitting={submitting}
          error={submitError}
        />
      ) : (
        <Card>
          <ul className="flex flex-col">
            {visibleNodes(page!, answers).map(({ item, depth }) => {
              const key = answerKey(item)
              return (
                <ItemRow
                  key={key}
                  node={item}
                  depth={depth}
                  answer={answersById.get(key)}
                  onChange={(patch) => onChange(
                    key, item.formItem.id, item.formItem.prompt,
                    item.asset?.id ?? null, item.repeatIndex ?? null, patch,
                  )}
                  onCapture={(file) => { void onCapture(key, file) }}
                  onDiscard={() => { void onDiscard(key) }}
                />
              )
            })}
          </ul>
          <PageFooterProgress page={page!} answers={answers} />
        </Card>
      )}

      {/* Next is never disabled — see the header. Back stops at the first page
          because there is nothing before it, which is a boundary rather than a
          gate. */}
      <div className="flex gap-2 sticky bottom-0 py-3"
           style={{ background: 'var(--bg-base)', borderTop: '1px solid var(--border)' }}>
        <Button
          variant="secondary"
          className="flex-1 flex items-center justify-center gap-1"
          disabled={stop === 0}
          onClick={() => setStop((s) => Math.max(0, s - 1))}
        >
          <ChevronLeft className="w-4 h-4" /> Back
        </Button>
        <Button
          variant="primary"
          className="flex-1 flex items-center justify-center gap-1"
          disabled={onReview}
          onClick={() => setStop((s) => Math.min(pages.length, s + 1))}
        >
          {stop === pages.length - 1 ? 'Review' : 'Next'} <ChevronRight className="w-4 h-4" />
        </Button>
      </div>

      <SectionIndex
        open={indexOpen}
        pages={pages}
        answers={answers}
        current={stop}
        onSelect={setStop}
        onClose={() => setIndexOpen(false)}
      />
    </Shell>
  )
}

/**
 * A draft row as the submit endpoint expects it.
 *
 * snake_case here, camelCase in Dexie — the boundary is deliberate. The local
 * draft is not a cached server row and must not look like one, or a bulkPut of
 * server rows into that table would type-check.
 */
function toSubmittedItem(r: InspectionAnswerRow) {
  return {
    form_item_id:    r.formItemId,
    prompt_snapshot: r.promptSnapshot,
    result:          r.result,
    actions:         r.actions,
    needs_cleaning:  r.needsCleaning,
    note:            r.note,
    photo_path:      r.photoPath,
    photo_unavailable_reason: r.photoUnavailableReason,
    na_reason:       r.naReason,
    value_number:    r.valueNumber,
    value_text:      r.valueText,
    value_date:      r.valueDate,
    asset_id:        r.assetId,
    repeat_index:    r.repeatIndex,
    answered_at:     r.answeredAt,
  }
}

/** What the screen shows once sign-off is queued — see the guard that renders it. */
function QueuedSubmitPanel({ failed, lastError, signedBy }: Readonly<{
  failed:    boolean
  lastError: string | undefined
  signedBy:  string
}>) {
  if (failed) {
    return (
      <Card>
        <div className="flex flex-col gap-2">
          <p className="text-sm font-semibold" style={{ color: 'var(--accent-red)' }}>
            This submission could not be sent.
          </p>
          <p className="text-xs" style={{ color: 'var(--text-secondary)' }}>
            {lastError ?? 'The server rejected it.'}
          </p>
          <p className="text-xs" style={{ color: 'var(--text-muted)' }}>
            Every answer is still held on this device. Use the sync banner to retry —
            nothing has been lost.
          </p>
        </div>
      </Card>
    )
  }

  return (
    <Card>
      <div className="flex flex-col gap-2">
        <p className="text-sm font-semibold flex items-center gap-2"
           style={{ color: 'var(--text-primary)' }}>
          <Clock className="w-4 h-4" style={{ color: 'var(--accent-gold)' }} />
          Signed off — waiting to send
        </p>
        <p className="text-xs" style={{ color: 'var(--text-muted)' }}>
          Signed by {signedBy || 'the inspector'}. This is queued on the device and
          will be filed the moment there is a connection. You can close the app.
        </p>
      </div>
    </Card>
  )
}

function PageFooterProgress({ page, answers }: Readonly<{
  page: Parameters<typeof pageProgress>[0]
  answers: Parameters<typeof pageProgress>[1]
}>) {
  const { answered, total } = pageProgress(page, answers)
  return (
    <p className="text-xs mt-3" style={{ color: 'var(--text-muted)' }}>
      {answered} of {total} answered on this page
    </p>
  )
}

function Shell({ children }: Readonly<{ children: React.ReactNode }>) {
  return <div className="p-4 sm:p-6 flex flex-col gap-4 max-w-3xl mx-auto">{children}</div>
}
