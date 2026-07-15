'use client'
import {
  Camera, CheckCircle2, Circle, Loader2, ImageIcon,
  StickyNote,
} from 'lucide-react'
import { cn } from '@/lib/utils'
import { Button } from '@/components/ui/Button'
import { retryFailedMutation } from '@/lib/dexie/helpers'
import type { ChecklistInstanceItemRow as ChecklistItem, TurnoverRow, ChecklistInstanceRow } from '@/lib/dexie/schema'
import type { TurnoverActions } from './use-turnover-actions'

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
    uploadingItemId, pendingUploadIds,
    openNoteItemId, setOpenNoteItemId, noteText, setNoteText,
    fileInputRefs, sectionPhotoRefs, sectionPhotoPrompt, setSectionPhotoPrompt,
    toggleItem, saveNote, openNote, handleSectionPhoto, handlePhotoCapture,
    toggleChecklistConfirm, checklistConfirmSyncFailed,
    items,
  } = actions

  return (
    <div className="mt-2">
      {/* Section header */}
      <div className="flex items-center justify-between mb-3 px-1">
        <h2 className="text-base font-semibold" style={{ color: 'var(--text-primary)' }}>
          Turnover Checklist
        </h2>
        <span className="text-sm" style={{ color: 'var(--text-muted)' }}>
          {completedCount} of {totalCount}
        </span>
      </div>

      {/* Checklist section */}
      {totalCount > 0 && (
        <>
          <div className="mb-3">
            <div className="flex items-center justify-between mb-1.5">
              <span className="text-sm font-semibold text-secondary-themed">
                Checklist — {completedCount} of {totalCount}
              </span>
              <span className="text-sm text-muted-themed">
                {Math.round((completedCount / totalCount) * 100)}%
              </span>
            </div>
            <div className="h-2 bg-raised-themed rounded-full overflow-hidden">
              <div
                className={cn('h-full rounded-full transition-all duration-300', completedCount !== totalCount && 'bg-brand-800')}
                style={{
                  width:      `${Math.round((completedCount / totalCount) * 100)}%`,
                  background: completedCount === totalCount ? 'var(--accent-green)' : undefined,
                }}
              />
            </div>
            {pendingPhotos.length > 0 && (
              <p className="text-xs mt-1.5 flex items-center gap-1" style={{ color: 'var(--accent-amber)' }}>
                <Camera className="w-3 h-3" />
                {pendingPhotos.length} item{pendingPhotos.length !== 1 ? 's' : ''} still
                need{pendingPhotos.length === 1 ? 's' : ''} a photo
              </p>
            )}
          </div>

          {Object.entries(sections).map(([sectionName, sectionItems]) => (
            <div key={sectionName} className="mb-4">
              <h3 className="text-xs font-semibold text-muted-themed uppercase tracking-wide mb-2 px-1">
                {sectionName}
              </h3>
              <div className="bg-card-themed rounded-xl border border-themed divide-y divide-themed overflow-hidden">
                {sectionItems.map((item: ChecklistItem) => {
                  const needsPhoto = item.requires_photo && !item.photo_storage_path
                  const uploading  = uploadingItemId === item.id

                  return (
                    <div key={item.id}>
                      <div
                        className={cn('flex items-start gap-3 px-4 py-3', !item.is_completed && 'bg-card-themed')}
                        style={item.is_completed ? { background: 'var(--accent-green-dim)' } : undefined}
                      >
                        <button
                          className="flex-shrink-0 mt-0.5 p-2 -m-2"
                          onClick={() => toggleItem(item.id, item.is_completed, item.requires_photo, item.photo_storage_path, sectionName)}
                          aria-label={item.is_completed ? 'Mark incomplete' : 'Mark complete'}
                        >
                          {item.is_completed
                            ? <CheckCircle2 className="w-5 h-5" style={{ color: 'var(--accent-green)' }} />
                            : <Circle className="w-5 h-5" style={{ color: needsPhoto ? 'var(--accent-amber)' : 'var(--text-muted)' }} />}
                        </button>

                        <button
                          type="button"
                          className="flex-1 min-w-0 cursor-pointer text-left"
                          onClick={() => toggleItem(item.id, item.is_completed, item.requires_photo, item.photo_storage_path, sectionName)}
                        >
                          <p
                            className={cn('text-sm leading-snug', item.is_completed ? 'line-through' : 'text-primary-themed')}
                            style={item.is_completed ? { color: 'var(--accent-green)' } : undefined}
                          >
                            {item.task}
                          </p>
                          {item.crew_notes && openNoteItemId !== item.id && (
                            <p className="text-xs text-muted-themed mt-0.5 italic">Note: {item.crew_notes}</p>
                          )}
                          {item.photo_storage_path && (
                            <p className="text-xs mt-0.5 flex items-center gap-1" style={{ color: 'var(--accent-green)' }}>
                              <ImageIcon className="w-3 h-3" /> Photo attached
                            </p>
                          )}
                          {!item.photo_storage_path && pendingUploadIds.has(item.id) && (
                            <p className="text-xs mt-0.5 flex items-center gap-1" style={{ color: 'var(--accent-amber)' }}>
                              <Loader2 className="w-3 h-3 animate-spin" /> Photo saved — uploading when back online
                            </p>
                          )}
                          {needsPhoto && !uploading && !pendingUploadIds.has(item.id) && (
                            <p className="text-xs mt-0.5" style={{ color: 'var(--accent-amber)' }}>Photo required before completing</p>
                          )}
                          {item.requires_photo && item.photo_reason && (
                            <p className="text-xs mt-0.5 flex items-center gap-1" style={{ color: 'var(--accent-amber)' }}>
                              <Camera className="w-3.5 h-3.5 flex-shrink-0" /> {item.photo_reason}
                            </p>
                          )}
                        </button>

                        {/* Note toggle button */}
                        <button
                          className="flex-shrink-0 mt-0.5 rounded transition-opacity active:opacity-60 flex items-center justify-center"
                          style={{
                            color:  openNoteItemId === item.id || item.crew_notes ? 'var(--accent-gold)' : 'var(--text-muted)',
                            width:  44,
                            height: 44,
                          }}
                          onClick={() => {
                            if (openNoteItemId === item.id) {
                              void saveNote(item.id, item.is_completed)
                            } else {
                              openNote(item.id, item.crew_notes ?? '')
                            }
                          }}
                          aria-label={openNoteItemId === item.id ? 'Save note' : 'Add note'}
                        >
                          <StickyNote className="w-4 h-4" />
                        </button>

                        {item.requires_photo && (
                          <div className="flex-shrink-0">
                            {uploading ? (
                              <div className="p-1.5"><Loader2 className="w-4 h-4 text-muted-themed animate-spin" /></div>
                            ) : (
                              <button
                                onClick={() => fileInputRefs.current[item.id]?.click()}
                                className="rounded-lg transition-colors flex items-center justify-center"
                                style={{
                                  width:      44,
                                  height:     44,
                                  color:      item.photo_storage_path ? 'var(--accent-green)' : 'var(--accent-amber)',
                                  background: item.photo_storage_path ? 'var(--accent-green-dim)' : 'var(--accent-amber-dim)',
                                }}
                                title={item.photo_storage_path ? 'Replace photo' : 'Tap to take required photo'}
                                aria-label={item.photo_storage_path ? 'Replace photo' : 'Take photo'}
                              >
                                <Camera className="w-4 h-4" />
                              </button>
                            )}
                            <input
                              ref={(el) => { fileInputRefs.current[item.id] = el }}
                              type="file" accept="image/*" capture="environment" className="hidden"
                              onChange={(e) => {
                                const file = e.target.files?.[0]
                                if (file) handlePhotoCapture(item.id, file)
                                e.target.value = ''
                              }}
                            />
                          </div>
                        )}
                      </div>

                      {/* Inline note textarea — appears below the item row */}
                      {openNoteItemId === item.id && (
                        <div className="px-4 pb-3 bg-card-themed border-t border-themed">
                          <textarea
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
                              onMouseDown={(e) => {
                                // mousedown fires before blur — prevent blur from saving
                                e.preventDefault()
                                setNoteText(items?.find(i => i.id === item.id)?.crew_notes ?? '')
                                setOpenNoteItemId(null)
                              }}
                              className="text-xs px-2.5 rounded flex items-center justify-center"
                              style={{ color: 'var(--text-muted)', minHeight: 44 }}
                            >
                              Cancel
                            </button>
                            <button
                              onMouseDown={(e) => {
                                e.preventDefault()
                                void saveNote(item.id, item.is_completed)
                              }}
                              className="text-xs px-2.5 rounded font-medium flex items-center justify-center"
                              style={{ background: 'var(--accent-gold)', color: 'var(--text-inverse)', minHeight: 44 }}
                            >
                              Save
                            </button>
                          </div>
                        </div>
                      )}
                    </div>
                  )
                })}
              </div>

              {/* Section-complete photo prompt */}
              {sectionPhotoPrompt === sectionName && (
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
                    ref={r => { sectionPhotoRefs.current[sectionName] = r }}
                    onChange={e => handleSectionPhoto(sectionName, e)}
                  />
                  <button
                    onClick={() => sectionPhotoRefs.current[sectionName]?.click()}
                    className="text-xs font-semibold px-3 rounded-lg flex items-center justify-center"
                    style={{ background: 'var(--accent-gold)', color: 'var(--text-inverse)', minHeight: 44, minWidth: 44 }}
                  >
                    Take Photo
                  </button>
                  <button
                    onClick={() => setSectionPhotoPrompt(null)}
                    className="text-xs px-2 rounded-lg text-muted-themed hover:bg-raised-themed flex items-center justify-center"
                    style={{ minHeight: 44, minWidth: 44 }}
                  >
                    Skip
                  </button>
                </div>
              )}
            </div>
          ))}

          {/* Confirm Checklist Complete — a deliberate human assertion,
              separate from per-item completion. Blocked while required
              photos are missing (same condition the manual "Mark Complete"
              button already checks); allows unchecking to correct a
              premature confirmation, as long as the turnover itself hasn't
              already fully completed. */}
          {instance && (
            <button
              type="button"
              onClick={() => void toggleChecklistConfirm()}
              disabled={
                (!instance.completed_at && pendingPhotos.length > 0)
                || turnover.status === 'completed'
              }
              className={cn(
                'w-full flex items-center gap-3 px-4 py-4 rounded-xl border-2 mt-2 mb-4 text-left transition-colors',
                !instance.completed_at && pendingPhotos.length > 0
                  ? 'border-themed opacity-60 cursor-not-allowed'
                  : !instance.completed_at && 'border-themed hover:bg-raised-themed',
                turnover.status === 'completed' && 'cursor-not-allowed'
              )}
              style={instance.completed_at ? { borderColor: 'var(--accent-green)', background: 'var(--accent-green-dim)' } : undefined}
            >
              {instance.completed_at
                ? <CheckCircle2 className="w-6 h-6 flex-shrink-0" style={{ color: 'var(--accent-green)' }} />
                : <Circle className="w-6 h-6 text-muted-themed flex-shrink-0" />}
              <div className="flex-1">
                <p className="text-base font-semibold" style={{ color: instance.completed_at ? 'var(--accent-green)' : 'var(--text-primary)' }}>
                  Confirm Checklist Complete
                </p>
                {!instance.completed_at && pendingPhotos.length > 0 && (
                  <p className="text-xs mt-0.5" style={{ color: 'var(--accent-amber)' }}>
                    {pendingPhotos.length} photo{pendingPhotos.length !== 1 ? 's' : ''} still required
                  </p>
                )}
              </div>
            </button>
          )}

          {checklistConfirmSyncFailed && (
            <div
              className="flex items-center justify-between gap-2 -mt-3 mb-4 px-4 py-2 rounded-lg text-xs"
              style={{ background: 'var(--accent-red-dim)', color: 'var(--accent-red)' }}
            >
              <span>Confirmation didn&rsquo;t sync — check your connection.</span>
              <button
                type="button"
                className="font-semibold underline flex-shrink-0"
                onClick={() => void retryFailedMutation(userId, 'checklist_instances', instance!.id)}
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

      {/* After the checklist, a sticky "Done" button to return to hub */}
      <div className="sticky bottom-0 pt-3 pb-6" style={{ background: 'var(--bg-page)' }}>
        <Button
          variant="secondary"
          onClick={onBack}
          className="w-full py-3"
        >
          ← Back to Turnover
        </Button>
      </div>
    </div>
  )
}
