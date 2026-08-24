'use client'
import {
  Camera, CheckCircle2, Circle, Loader2, ImageIcon,
  StickyNote,
} from 'lucide-react'
import { cn } from '@/lib/utils'
import { Button } from '@/components/ui/Button'
import { retryFailedMutation } from '@/lib/dexie/helpers'
import type { ChecklistInstanceItemRow as ChecklistItem, TurnoverRow, ChecklistInstanceRow } from '@/lib/dexie/schema'
import type { AssetType } from '@/types/database'
import { DiscoveryCaptureModal } from '@/app/crew/_components/discovery-capture-modal'
import type { TurnoverActions } from './use-turnover-actions'

// ─────────────────────────────────────────────────────────────────────────────
// WHY THIS FILE IS A SET OF COMPONENTS AND NOT ONE FUNCTION
//
// It was one 350-line `return`, at cognitive complexity 45 against a limit of
// 15, with a closure nested five deep inside it. None of that came from hard
// logic — it is conditional RENDERING, six or seven independent decisions
// interleaved in one JSX tree, which is the shape that reads fine while you are
// writing it and is unreviewable a month later.
//
// The split is by what each piece decides, so each name answers one question:
// how far along is the checklist, what does this row look like, is a photo
// needed, is the note open, has the section just finished, can the whole thing
// be confirmed. They are co-located rather than filed under _components/
// because every one of them is private to this screen and would be a directory
// of single-use files otherwise.
//
// `unit/guardrails/asset-discovery-capture-wiring.test.ts` scans this file for
// the discovery chain — asset_discovery_type, startAssetCapture,
// DiscoveryCaptureModal, onCaptured -> completeCapturedItem. Those stay in this
// file for that reason as much as any other: the guardrail exists because
// breaking any link silently reissues a survey prompt forever.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * An Asset Discovery row opens the capture form instead of toggling, so its
 * label describes what the tap actually does.
 */
function itemActionLabel(capturable: boolean, isCompleted: number): string {
  if (capturable) return 'Capture asset details'
  return isCompleted ? 'Mark incomplete' : 'Mark complete'
}

export function ChecklistView({
  turnover,
  instance,
  actions,
  onBack,
}: Readonly<{
  turnover: TurnoverRow
  instance: ChecklistInstanceRow | undefined
  actions:  TurnoverActions
  onBack:   () => void
}>) {
  const {
    userId,
    completedCount, totalCount, pendingPhotos, sections,
    sectionPhotoPrompt, setSectionPhotoPrompt,
    registerSectionInput, openSectionPicker,
    capturingAsset, setCapturingAsset, completeCapturedItem,
    handleSectionPhoto,
    toggleChecklistConfirm, checklistConfirmSyncFailed, actionError,
    isCancelled,
  } = actions

  return (
    <div className="mt-2">
      <div className="flex items-center justify-between mb-3 px-1">
        <h2 className="text-base font-semibold" style={{ color: 'var(--text-primary)' }}>
          Turnover Checklist
        </h2>
        <span className="text-sm" style={{ color: 'var(--text-muted)' }}>
          {completedCount} of {totalCount}
        </span>
      </div>

      {totalCount > 0 && (
        <>
          <ChecklistProgress
            completedCount={completedCount}
            totalCount={totalCount}
            pendingPhotoCount={pendingPhotos.length}
          />

          {Object.entries(sections).map(([sectionName, sectionItems]) => (
            <div key={sectionName} className="mb-4">
              <h3 className="text-xs font-semibold text-muted-themed uppercase tracking-wide mb-2 px-1">
                {sectionName}
              </h3>
              <div className="bg-card-themed rounded-xl border border-themed divide-y divide-themed overflow-hidden">
                {sectionItems.map((item: ChecklistItem) => (
                  <ChecklistItemRow
                    key={item.id}
                    item={item}
                    sectionName={sectionName}
                    actions={actions}
                  />
                ))}
              </div>

              {sectionPhotoPrompt === sectionName && (
                <SectionPhotoPrompt
                  sectionName={sectionName}
                  onRegisterInput={registerSectionInput}
                  onOpenPicker={openSectionPicker}
                  onCapture={handleSectionPhoto}
                  onSkip={() => setSectionPhotoPrompt(null)}
                />
              )}
            </div>
          ))}

          {instance && (
            <ConfirmChecklistButton
              instance={instance}
              turnoverStatus={turnover.status}
              isCancelled={isCancelled}
              pendingPhotoCount={pendingPhotos.length}
              onToggle={() => void toggleChecklistConfirm()}
            />
          )}

          {/* A refusal before the mutation is ever enqueued (e.g. the crew
              profile hasn't resolved yet) used to be a bare `return`, leaving
              the button above a dead control with no feedback at all. */}
          {actionError && (
            <div
              className="-mt-3 mb-4 px-4 py-2 rounded-lg text-xs"
              style={{ background: 'var(--accent-red-dim)', color: 'var(--accent-red)' }}
            >
              {actionError}
            </div>
          )}

          {checklistConfirmSyncFailed && instance && (
            <div
              className="flex items-center justify-between gap-2 -mt-3 mb-4 px-4 py-2 rounded-lg text-xs"
              style={{ background: 'var(--accent-red-dim)', color: 'var(--accent-red)' }}
            >
              <span>Confirmation didn&rsquo;t sync — check your connection.</span>
              <button
                type="button"
                className="font-semibold underline flex-shrink-0"
                onClick={() => void retryFailedMutation(userId, 'checklist_instances', instance.id)}
              >
                Retry
              </button>
            </div>
          )}
        </>
      )}

      {totalCount === 0 && (
        <div className="bg-card-themed rounded-xl border border-themed p-6 text-center text-muted-themed text-sm mb-4">
          No checklist for this turnover.
        </div>
      )}

      <div className="sticky bottom-0 pt-3 pb-6" style={{ background: 'var(--bg-page)' }}>
        <Button
          variant="secondary"
          onClick={onBack}
          className="w-full py-3"
        >
          ← Back to Turnover
        </Button>
      </div>

      {/* The same modal the standalone /crew/assets screen uses. The checklist
          item is ticked from onCaptured, never by hand, so a completed prompt
          always has a property_assets row behind it — which is what makes the
          item fall off the NEXT turnover instead of being reissued forever. */}
      {capturingAsset && (
        <DiscoveryCaptureModal
          propertyId={turnover.property_id}
          orgId={turnover.org_id}
          assetType={capturingAsset.assetType}
          userId={userId}
          onCaptured={() => { void completeCapturedItem(capturingAsset.itemId) }}
          onClose={() => setCapturingAsset(null)}
        />
      )}
    </div>
  )
}

// ── Progress ────────────────────────────────────────────────────────────────

function ChecklistProgress({
  completedCount, totalCount, pendingPhotoCount,
}: Readonly<{ completedCount: number; totalCount: number; pendingPhotoCount: number }>) {
  const pct  = Math.round((completedCount / totalCount) * 100)
  const done = completedCount === totalCount

  return (
    <div className="mb-3">
      <div className="flex items-center justify-between mb-1.5">
        <span className="text-sm font-semibold text-secondary-themed">
          Checklist — {completedCount} of {totalCount}
        </span>
        <span className="text-sm text-muted-themed">{pct}%</span>
      </div>
      <div className="h-2 bg-raised-themed rounded-full overflow-hidden">
        <div
          className={cn('h-full rounded-full transition-all duration-300', !done && 'bg-brand-800')}
          style={{ width: `${pct}%`, background: done ? 'var(--accent-green)' : undefined }}
        />
      </div>
      {pendingPhotoCount > 0 && (
        <p className="text-xs mt-1.5 flex items-center gap-1" style={{ color: 'var(--accent-amber)' }}>
          <Camera className="w-3 h-3" />
          {pendingPhotoCount} item{pendingPhotoCount !== 1 ? 's' : ''} still
          need{pendingPhotoCount === 1 ? 's' : ''} a photo
        </p>
      )}
    </div>
  )
}

// ── One checklist row ───────────────────────────────────────────────────────

function ChecklistItemRow({
  item, sectionName, actions,
}: Readonly<{ item: ChecklistItem; sectionName: string; actions: TurnoverActions }>) {
  const {
    uploadingItemId, pendingUploadIds, openNoteItemId,
    startAssetCapture, toggleItem, saveNote, openNote,
    registerItemInput, openItemPicker,
  } = actions

  const needsPhoto = Boolean(item.requires_photo) && !item.photo_storage_path
  const uploading  = uploadingItemId === item.id
  // An Asset Discovery row completes by CAPTURING, not by ticking — see
  // startAssetCapture in use-turnover-actions.
  const discoveryType = item.asset_discovery_type as AssetType | ''
  const capturable    = Boolean(discoveryType) && !item.is_completed
  const noteOpen      = openNoteItemId === item.id

  const activate = capturable
    ? () => startAssetCapture(item.id, discoveryType as AssetType)
    : () => toggleItem(item.id, item.is_completed, item.requires_photo, item.photo_storage_path, sectionName)

  const onNoteButton = () => {
    if (noteOpen) void saveNote(item.id, item.is_completed)
    else openNote(item.id, item.crew_notes ?? '')
  }

  return (
    <div>
      <div
        className={cn('flex items-start gap-3 px-4 py-3', !item.is_completed && 'bg-card-themed')}
        style={item.is_completed ? { background: 'var(--accent-green-dim)' } : undefined}
      >
        <ItemToggleButton
          item={item}
          capturable={capturable}
          highlight={needsPhoto || Boolean(discoveryType)}
          onActivate={activate}
        />

        <button
          type="button"
          className="flex-1 min-w-0 cursor-pointer text-left"
          onClick={activate}
        >
          <p
            className={cn('text-sm leading-snug', item.is_completed ? 'line-through' : 'text-primary-themed')}
            style={item.is_completed ? { color: 'var(--accent-green)' } : undefined}
          >
            {item.task}
          </p>
          <ItemStatusLines
            item={item}
            noteOpen={noteOpen}
            uploading={uploading}
            needsPhoto={needsPhoto}
            photoQueued={pendingUploadIds.has(item.id)}
          />
        </button>

        <ItemNoteButton
          active={noteOpen || Boolean(item.crew_notes)}
          noteOpen={noteOpen}
          onClick={onNoteButton}
        />

        {item.requires_photo && (
          <ItemPhotoControl
            item={item}
            uploading={uploading}
            onRegisterInput={(el) => registerItemInput(item.id, el)}
            onOpenPicker={() => openItemPicker(item.id)}
            onCapture={actions.handlePhotoCapture}
          />
        )}
      </div>

      {noteOpen && <ItemNoteEditor item={item} actions={actions} />}
    </div>
  )
}

function ItemToggleButton({
  item, capturable, highlight, onActivate,
}: Readonly<{
  item:       ChecklistItem
  capturable: boolean
  highlight:  boolean
  onActivate: () => void
}>) {
  return (
    <button
      className="flex-shrink-0 mt-0.5 p-2 -m-2"
      onClick={onActivate}
      aria-label={itemActionLabel(capturable, item.is_completed)}
    >
      {item.is_completed
        ? <CheckCircle2 className="w-5 h-5" style={{ color: 'var(--accent-green)' }} />
        : <Circle className="w-5 h-5" style={{ color: highlight ? 'var(--accent-amber)' : 'var(--text-muted)' }} />}
    </button>
  )
}

function ItemNoteButton({
  active, noteOpen, onClick,
}: Readonly<{ active: boolean; noteOpen: boolean; onClick: () => void }>) {
  return (
    <button
      className="flex-shrink-0 mt-0.5 rounded transition-opacity active:opacity-60 flex items-center justify-center"
      style={{
        color:  active ? 'var(--accent-gold)' : 'var(--text-muted)',
        width:  44,
        height: 44,
      }}
      onClick={onClick}
      aria-label={noteOpen ? 'Save note' : 'Add note'}
    >
      <StickyNote className="w-4 h-4" />
    </button>
  )
}

/**
 * The four independent status lines under an item's label.
 *
 * Separated because they are four unrelated conditions rendered adjacently, and
 * adjacency is the only thing they have in common — interleaved with the row's
 * own markup they were four of the branches that put this file at 45.
 */
function ItemStatusLines({
  item, noteOpen, uploading, needsPhoto, photoQueued,
}: Readonly<{
  item:        ChecklistItem
  noteOpen:    boolean
  uploading:   boolean
  needsPhoto:  boolean
  photoQueued: boolean
}>) {
  return (
    <>
      {item.crew_notes && !noteOpen && (
        <p className="text-xs text-muted-themed mt-0.5 italic">Note: {item.crew_notes}</p>
      )}
      {item.photo_storage_path && (
        <p className="text-xs mt-0.5 flex items-center gap-1" style={{ color: 'var(--accent-green)' }}>
          <ImageIcon className="w-3 h-3" /> Photo attached
        </p>
      )}
      {!item.photo_storage_path && photoQueued && (
        <p className="text-xs mt-0.5 flex items-center gap-1" style={{ color: 'var(--accent-amber)' }}>
          <Loader2 className="w-3 h-3 animate-spin" /> Photo saved — uploading when back online
        </p>
      )}
      {needsPhoto && !uploading && !photoQueued && (
        <p className="text-xs mt-0.5" style={{ color: 'var(--accent-amber)' }}>Photo required before completing</p>
      )}
      {item.requires_photo && item.photo_reason && (
        <p className="text-xs mt-0.5 flex items-center gap-1" style={{ color: 'var(--accent-amber)' }}>
          <Camera className="w-3.5 h-3.5 flex-shrink-0" /> {item.photo_reason}
        </p>
      )}
    </>
  )
}

function ItemPhotoControl({
  item, uploading, onRegisterInput, onOpenPicker, onCapture,
}: Readonly<{
  item:            ChecklistItem
  uploading:       boolean
  onRegisterInput: (el: HTMLInputElement | null) => void
  onOpenPicker:    () => void
  onCapture:       TurnoverActions['handlePhotoCapture']
}>) {
  const hasPhoto = !!item.photo_storage_path

  return (
    <div className="flex-shrink-0">
      {uploading ? (
        <div className="p-1.5"><Loader2 className="w-4 h-4 text-muted-themed animate-spin" /></div>
      ) : (
        <button
          onClick={onOpenPicker}
          className="rounded-lg transition-colors flex items-center justify-center"
          style={{
            width:      44,
            height:     44,
            color:      hasPhoto ? 'var(--accent-green)' : 'var(--accent-amber)',
            background: hasPhoto ? 'var(--accent-green-dim)' : 'var(--accent-amber-dim)',
          }}
          title={hasPhoto ? 'Replace photo' : 'Tap to take required photo'}
          aria-label={hasPhoto ? 'Replace photo' : 'Take photo'}
        >
          <Camera className="w-4 h-4" />
        </button>
      )}
      <input
        ref={onRegisterInput}
        type="file" accept="image/*" capture="environment" className="hidden"
        onChange={(e) => {
          const file = e.target.files?.[0]
          if (file) onCapture(item.id, file)
          e.target.value = ''
        }}
      />
    </div>
  )
}

/**
 * The inline note textarea.
 *
 * Extracted for depth as much as for size: its Cancel handler sat five closures
 * deep inside the original tree and tripped `no-nested-functions` on its own.
 */
function ItemNoteEditor({
  item, actions,
}: Readonly<{ item: ChecklistItem; actions: TurnoverActions }>) {
  const { noteText, setNoteText, saveNote, setOpenNoteItemId, items } = actions

  // mousedown fires BEFORE blur, so preventing default is what stops the blur
  // handler saving the very edit this button exists to discard.
  const cancel = (e: React.MouseEvent) => {
    e.preventDefault()
    setNoteText(items?.find((i) => i.id === item.id)?.crew_notes ?? '')
    setOpenNoteItemId(null)
  }

  const save = (e: React.MouseEvent) => {
    e.preventDefault()
    void saveNote(item.id, item.is_completed)
  }

  return (
    <div className="px-4 pb-3 bg-card-themed border-t border-themed">
      <textarea
        // Revealed by tapping "add note" on this item — focusing it is the
        // point of the tap, not page-load focus stealing.
        // eslint-disable-next-line jsx-a11y/no-autofocus
        autoFocus
        value={noteText}
        onChange={(e) => setNoteText(e.target.value)}
        onBlur={() => void saveNote(item.id, item.is_completed)}
        rows={2}
        placeholder="Add a note for this item…"
        className="w-full mt-2 text-sm rounded-lg px-3 py-2 resize-none border border-themed focus:outline-none focus:border-brand-400"
        style={{ background: 'var(--bg-raised)', color: 'var(--text-primary)' }}
      />
      <div className="flex justify-end gap-2 mt-1.5">
        <button
          onMouseDown={cancel}
          className="text-xs px-2.5 rounded flex items-center justify-center"
          style={{ color: 'var(--text-muted)', minHeight: 44 }}
        >
          Cancel
        </button>
        <button
          onMouseDown={save}
          className="text-xs px-2.5 rounded font-medium flex items-center justify-center"
          style={{ background: 'var(--accent-gold)', color: 'var(--text-inverse)', minHeight: 44 }}
        >
          Save
        </button>
      </div>
    </div>
  )
}

// ── Section + confirmation ──────────────────────────────────────────────────

function SectionPhotoPrompt({
  sectionName, onRegisterInput, onOpenPicker, onCapture, onSkip,
}: Readonly<{
  sectionName:     string
  onRegisterInput: (sectionName: string, el: HTMLInputElement | null) => void
  onOpenPicker:    (sectionName: string) => void
  onCapture:       TurnoverActions['handleSectionPhoto']
  onSkip:          () => void
}>) {
  return (
    <div
      className="flex items-center gap-3 mt-2 p-3 rounded-xl border-2 border-dashed"
      style={{ borderColor: 'var(--accent-gold)', background: 'var(--accent-gold-dim)' }}
    >
      <Camera className="w-5 h-5 flex-shrink-0" style={{ color: 'var(--accent-gold)' }} />
      <div className="flex-1 text-sm font-medium" style={{ color: 'var(--accent-gold)' }}>
        Section complete — add a final photo
      </div>
      <input
        type="file"
        accept="image/*"
        capture="environment"
        className="hidden"
        ref={(r) => onRegisterInput(sectionName, r)}
        onChange={(e) => onCapture(sectionName, e)}
      />
      <button
        onClick={() => onOpenPicker(sectionName)}
        className="text-xs font-semibold px-3 rounded-lg flex items-center justify-center"
        style={{ background: 'var(--accent-gold)', color: 'var(--text-inverse)', minHeight: 44, minWidth: 44 }}
      >
        Take Photo
      </button>
      <button
        onClick={onSkip}
        className="text-xs px-2 rounded-lg text-muted-themed hover:bg-raised-themed flex items-center justify-center"
        style={{ minHeight: 44, minWidth: 44 }}
      >
        Skip
      </button>
    </div>
  )
}

/**
 * "Confirm Checklist Complete" — a deliberate human assertion, separate from
 * per-item completion.
 *
 * Blocked while required photos are missing (the same condition the manual
 * "Mark Complete" button already checks), and allows UNCHECKING to correct a
 * premature confirmation, as long as the turnover itself has not already fully
 * completed.
 */
function ConfirmChecklistButton({
  instance, turnoverStatus, isCancelled, pendingPhotoCount, onToggle,
}: Readonly<{
  instance:          ChecklistInstanceRow
  turnoverStatus:    TurnoverRow['status']
  isCancelled:       boolean
  pendingPhotoCount: number
  onToggle:          () => void
}>) {
  const confirmed   = !!instance.completed_at
  const photosShort = !confirmed && pendingPhotoCount > 0
  const locked      = turnoverStatus === 'completed' || isCancelled

  return (
    <button
      type="button"
      onClick={onToggle}
      disabled={photosShort || locked}
      className={cn(
        'w-full flex items-center gap-3 px-4 py-4 rounded-xl border-2 mt-2 mb-4 text-left transition-colors',
        photosShort ? 'border-themed opacity-60 cursor-not-allowed' : !confirmed && 'border-themed hover:bg-raised-themed',
        locked && 'cursor-not-allowed',
      )}
      style={confirmed ? { borderColor: 'var(--accent-green)', background: 'var(--accent-green-dim)' } : undefined}
    >
      {confirmed
        ? <CheckCircle2 className="w-6 h-6 flex-shrink-0" style={{ color: 'var(--accent-green)' }} />
        : <Circle className="w-6 h-6 text-muted-themed flex-shrink-0" />}
      <div className="flex-1">
        <p className="text-base font-semibold" style={{ color: confirmed ? 'var(--accent-green)' : 'var(--text-primary)' }}>
          Confirm Checklist Complete
        </p>
        {photosShort && (
          <p className="text-xs mt-0.5" style={{ color: 'var(--accent-amber)' }}>
            {pendingPhotoCount} photo{pendingPhotoCount !== 1 ? 's' : ''} still required
          </p>
        )}
      </div>
    </button>
  )
}
