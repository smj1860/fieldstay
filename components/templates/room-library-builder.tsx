'use client'

import { useState, useTransition } from 'react'
import { Plus, Trash2, ChevronUp, ChevronDown, ChevronRight, Camera, Check, Home } from 'lucide-react'
import { Button } from '@/components/ui/Button'
import { Badge } from '@/components/ui/Badge'
import { Checkbox } from '@/components/ui/Checkbox'
import { InlineAlert } from '@/components/ui/InlineAlert'
import {
  createRoomTemplate,
  renameRoomTemplate,
  deleteRoomTemplate,
  saveRoomTemplateItems,
  setRoomTemplateAutoInclude,
  type RoomTemplateItemInput,
} from '@/app/(dashboard)/templates/checklist/actions'

interface ItemState {
  tempId: string
  task: string
  requires_photo: boolean
  notes: string
}

interface RoomState {
  id: string
  name: string
  autoInclude: boolean
  isSystem: boolean
  items: ItemState[]
}

function makeId() {
  if (typeof globalThis.crypto?.randomUUID === 'function') return globalThis.crypto.randomUUID()
  return `tmp-${Date.now()}-${Math.random().toString(36).slice(2)}`
}

// Reuses the item's own stable server id as the tempId rather than
// generating a fresh one — this runs inside useState's lazy initializer,
// which executes once during SSR and again during client hydration; a
// freshly-generated id (random, or even the previous 'ssr' placeholder
// literal) would differ — or collide — between those two passes and either
// produce duplicate React keys or a hydration mismatch. The server id is
// identical both times since it comes from the initialRooms prop.
function toItemState(item: { id: string; task: string; requires_photo: boolean; notes: string }): ItemState {
  return { tempId: item.id, task: item.task, requires_photo: item.requires_photo, notes: item.notes }
}

// Pure list-transform helpers, kept at module scope rather than nested
// inside the component's event handlers — nesting them there would stack
// another two levels of function-in-function on top (component -> handler
// -> setRooms callback -> prev.map callback -> this callback) and trip the
// "functions nested more than 4 deep" check.
function renameRoomInList(rooms: RoomState[], roomId: string, name: string): RoomState[] {
  return rooms.map((r) => (r.id === roomId ? { ...r, name } : r))
}

function setRoomAutoIncludeInList(rooms: RoomState[], roomId: string, autoInclude: boolean): RoomState[] {
  return rooms.map((r) => (r.id === roomId ? { ...r, autoInclude } : r))
}

function addItemToRoom(rooms: RoomState[], roomId: string): RoomState[] {
  return rooms.map((r) =>
    r.id === roomId
      ? { ...r, items: [...r.items, { tempId: makeId(), task: '', requires_photo: false, notes: '' }] }
      : r
  )
}

function filterOutItem(items: ItemState[], itemTempId: string): ItemState[] {
  return items.filter((i) => i.tempId !== itemTempId)
}

function removeItemFromRoom(rooms: RoomState[], roomId: string, itemTempId: string): RoomState[] {
  return rooms.map((r) => (r.id === roomId ? { ...r, items: filterOutItem(r.items, itemTempId) } : r))
}

function mapUpdatedItem(items: ItemState[], itemTempId: string, field: keyof ItemState, value: unknown): ItemState[] {
  return items.map((i) => (i.tempId === itemTempId ? { ...i, [field]: value } : i))
}

function updateItemInRoom(
  rooms: RoomState[],
  roomId: string,
  itemTempId: string,
  field: keyof ItemState,
  value: unknown
): RoomState[] {
  return rooms.map((r) => (r.id === roomId ? { ...r, items: mapUpdatedItem(r.items, itemTempId, field, value) } : r))
}

function reorderItems(items: ItemState[], itemTempId: string, dir: -1 | 1): ItemState[] {
  const idx = items.findIndex((i) => i.tempId === itemTempId)
  const swap = idx + dir
  if (swap < 0 || swap >= items.length) {
    return items
  }
  const next = [...items]
  ;[next[idx], next[swap]] = [next[swap], next[idx]]
  return next
}

function moveItemInRoom(rooms: RoomState[], roomId: string, itemTempId: string, dir: -1 | 1): RoomState[] {
  return rooms.map((r) => (r.id === roomId ? { ...r, items: reorderItems(r.items, itemTempId, dir) } : r))
}

function removeRoomFromList(rooms: RoomState[], roomId: string): RoomState[] {
  return rooms.filter((r) => r.id !== roomId)
}

function buildItemsPayload(items: ItemState[]): RoomTemplateItemInput[] {
  return items.map((item, i) => ({
    task:           item.task,
    requires_photo: item.requires_photo,
    notes:          item.notes,
    sort_order:     i,
  }))
}

function saveButtonLabel(saving: boolean, saved: boolean) {
  if (saving) return 'Saving…'
  if (saved) return <><Check className="w-4 h-4" /> Saved</>
  return 'Save Room'
}

function continueButtonLabel(continuing: boolean, propertyCount: number | undefined): string {
  if (continuing) return 'Applying…'
  if (propertyCount) return `Continue — apply to ${propertyCount} propert${propertyCount === 1 ? 'y' : 'ies'}`
  return 'Continue'
}

export function RoomLibraryBuilder({
  initialRooms,
  canManage,
  continueAction,
  continuePropertyCount,
}: Readonly<{
  initialRooms: Array<{ id: string; name: string; autoInclude: boolean; isSystem: boolean; items: Array<{ id: string; task: string; requires_photo: boolean; notes: string }> }>
  canManage: boolean
  continueAction?: () => Promise<void>
  continuePropertyCount?: number
}>) {
  const [rooms, setRooms] = useState<RoomState[]>(() =>
    initialRooms.map((r) => ({ id: r.id, name: r.name, autoInclude: r.autoInclude, isSystem: r.isSystem, items: r.items.map(toItemState) }))
  )
  const [expanded, setExpanded] = useState<Set<string>>(new Set())
  const [newRoomName, setNewRoomName] = useState('')
  const [creating, startCreate] = useTransition()
  const [error, setError] = useState<string | null>(null)
  const [savedRoomId, setSavedRoomId] = useState<string | null>(null)
  const [continuing, startContinue] = useTransition()

  const toggleExpanded = (id: string) => {
    setExpanded((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }

  const handleCreateRoom = () => {
    const name = newRoomName.trim()
    if (!name) return
    startCreate(async () => {
      const result = await createRoomTemplate(name)
      if (result.error || !result.id) {
        setError(result.error ?? 'Failed to create room template.')
        return
      }
      setRooms((prev) => [...prev, { id: result.id!, name, autoInclude: false, isSystem: false, items: [] }])
      setExpanded((prev) => new Set(prev).add(result.id!))
      setNewRoomName('')
      setError(null)
    })
  }

  const updateRoomName = (roomId: string, name: string) => {
    setRooms((prev) => renameRoomInList(prev, roomId, name))
  }

  const toggleAutoInclude = (roomId: string) => {
    const room = rooms.find((r) => r.id === roomId)
    if (!room) return
    const next = !room.autoInclude
    setRooms((prev) => setRoomAutoIncludeInList(prev, roomId, next))
    startCreate(async () => {
      const result = await setRoomTemplateAutoInclude(roomId, next)
      if (result.error) {
        setError(result.error)
        setRooms((prev) => setRoomAutoIncludeInList(prev, roomId, !next))
      }
    })
  }

  const addItem = (roomId: string) => {
    setRooms((prev) => addItemToRoom(prev, roomId))
  }

  const removeItem = (roomId: string, itemTempId: string) => {
    setRooms((prev) => removeItemFromRoom(prev, roomId, itemTempId))
  }

  const updateItem = (roomId: string, itemTempId: string, field: keyof ItemState, value: unknown) => {
    setRooms((prev) => updateItemInRoom(prev, roomId, itemTempId, field, value))
  }

  const moveItem = (roomId: string, itemTempId: string, dir: -1 | 1) => {
    setRooms((prev) => moveItemInRoom(prev, roomId, itemTempId, dir))
  }

  const handleSaveRoom = (room: RoomState, nameChanged: boolean) => {
    startCreate(async () => {
      setError(null)
      if (nameChanged) {
        const renameResult = await renameRoomTemplate(room.id, room.name)
        if (renameResult.error) { setError(renameResult.error); return }
      }
      const itemsResult = await saveRoomTemplateItems(room.id, buildItemsPayload(room.items))
      if (itemsResult.error) { setError(itemsResult.error); return }
      setSavedRoomId(room.id)
      setTimeout(() => setSavedRoomId(null), 2000)
    })
  }

  const handleDeleteRoom = (roomId: string) => {
    startCreate(async () => {
      setError(null)
      const result = await deleteRoomTemplate(roomId)
      if (result.error) { setError(result.error); return }
      setRooms((prev) => removeRoomFromList(prev, roomId))
    })
  }

  function handleContinue() {
    if (!continueAction) return
    startContinue(async () => { await continueAction() })
  }

  return (
    <div className="space-y-4">
      {error && <InlineAlert tone="error">{error}</InlineAlert>}

      {rooms.length === 0 && (
        <div className="border border-dashed border-themed rounded-xl p-8 text-center">
          <Home className="w-6 h-6 mx-auto mb-2 text-muted-themed" />
          <p className="text-sm text-muted-themed">
            No room templates yet. Build your first one below — e.g. &quot;Standard Bedroom&quot;
            or &quot;Standard Bathroom&quot; — then use it when setting up any property&apos;s checklist.
          </p>
        </div>
      )}

      {rooms.map((room) => {
        const isOpen = expanded.has(room.id)
        return (
          <RoomCard
            key={room.id}
            room={room}
            isOpen={isOpen}
            canManage={canManage}
            saved={savedRoomId === room.id}
            onToggle={() => toggleExpanded(room.id)}
            onNameChange={(name) => updateRoomName(room.id, name)}
            onToggleAutoInclude={() => toggleAutoInclude(room.id)}
            onAddItem={() => addItem(room.id)}
            onRemoveItem={(itemTempId) => removeItem(room.id, itemTempId)}
            onUpdateItem={(itemTempId, field, value) => updateItem(room.id, itemTempId, field, value)}
            onMoveItem={(itemTempId, dir) => moveItem(room.id, itemTempId, dir)}
            onSave={(nameChanged) => handleSaveRoom(room, nameChanged)}
            onDelete={() => handleDeleteRoom(room.id)}
            saving={creating}
          />
        )
      })}

      {canManage && (
        <div className="flex gap-2">
          <input
            value={newRoomName}
            onChange={(e) => setNewRoomName(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter') handleCreateRoom() }}
            placeholder="New room name — e.g. Standard Bedroom"
            className="input flex-1 text-sm"
          />
          <Button
            variant="secondary"
            onClick={handleCreateRoom}
            disabled={creating || !newRoomName.trim()}
            className="inline-flex items-center gap-1.5"
          >
            <Plus className="w-4 h-4" /> Add Room Template
          </Button>
        </div>
      )}

      {continueAction && (
        <div className="flex justify-end pt-2">
          <Button onClick={handleContinue} disabled={continuing} className="inline-flex items-center gap-1.5">
            {continueButtonLabel(continuing, continuePropertyCount)}
          </Button>
        </div>
      )}
    </div>
  )
}

function RoomCard({
  room,
  isOpen,
  canManage,
  saved,
  saving,
  onToggle,
  onNameChange,
  onToggleAutoInclude,
  onAddItem,
  onRemoveItem,
  onUpdateItem,
  onMoveItem,
  onSave,
  onDelete,
}: Readonly<{
  room: RoomState
  isOpen: boolean
  canManage: boolean
  saved: boolean
  saving: boolean
  onToggle: () => void
  onNameChange: (name: string) => void
  onToggleAutoInclude: () => void
  onAddItem: () => void
  onRemoveItem: (itemTempId: string) => void
  onUpdateItem: (itemTempId: string, field: keyof ItemState, value: unknown) => void
  onMoveItem: (itemTempId: string, dir: -1 | 1) => void
  onSave: (nameChanged: boolean) => void
  onDelete: () => void
}>) {
  const [initialName] = useState(room.name)
  const [confirmDelete, setConfirmDelete] = useState(false)

  return (
    <div className="border border-themed rounded-xl overflow-hidden">
      <button
        type="button"
        onClick={onToggle}
        className="w-full flex items-center gap-2 px-4 py-3 text-left hover:bg-raised-themed transition-colors"
      >
        <ChevronRight className={`w-4 h-4 flex-shrink-0 transition-transform text-muted-themed ${isOpen ? 'rotate-90' : ''}`} />
        <span className="text-sm font-semibold text-primary-themed flex-1">{room.name}</span>
        {room.isSystem && (
          <Badge tone="slate" className="flex-shrink-0">Built into FieldStay</Badge>
        )}
        {room.autoInclude && (
          <span
            className="px-2 py-0.5 rounded-full text-xs font-medium flex-shrink-0"
            style={{ background: 'var(--accent-gold-dim)', color: 'var(--accent-gold)' }}
          >
            On every property
          </span>
        )}
        <span className="text-xs text-muted-themed">{room.items.length} task{room.items.length !== 1 ? 's' : ''}</span>
      </button>

      {isOpen && (
        <div className="border-t border-themed px-4 py-4 space-y-3">
          {canManage && (
            <input
              value={room.name}
              onChange={(e) => onNameChange(e.target.value)}
              className="input w-full text-sm font-medium"
              placeholder="Room name"
            />
          )}

          <label htmlFor={`auto-include-${room.id}`} className="flex items-start gap-2 cursor-pointer">
            <Checkbox
              id={`auto-include-${room.id}`}
              checked={room.autoInclude}
              onChange={onToggleAutoInclude}
              disabled={!canManage}
              className="mt-0.5"
            />
            <span className="text-xs text-muted-themed">
              Automatically include this room on every property&apos;s checklist
              (for whole-home walkthroughs, not opt-in rooms like bedrooms or
              bathrooms — those get added per-property via the quantity picker).
            </span>
          </label>

          <div className="divide-y divide-themed border border-themed rounded-lg overflow-hidden">
            {room.items.map((item, ii) => (
              <div key={item.tempId} className="flex items-center gap-2 px-3 py-2 group hover:bg-raised-themed">
                <div className="flex gap-0.5">
                  <Button variant="ghost" onClick={() => onMoveItem(item.tempId, -1)} disabled={ii === 0} className="p-0.5 disabled:opacity-30">
                    <ChevronUp className="w-3 h-3" />
                  </Button>
                  <Button variant="ghost" onClick={() => onMoveItem(item.tempId, 1)} disabled={ii === room.items.length - 1} className="p-0.5 disabled:opacity-30">
                    <ChevronDown className="w-3 h-3" />
                  </Button>
                </div>
                <input
                  value={item.task}
                  onChange={(e) => onUpdateItem(item.tempId, 'task', e.target.value)}
                  placeholder="Task description…"
                  className="flex-1 text-sm text-primary-themed bg-transparent focus:outline-none placeholder:text-[var(--text-muted)] border-b border-[color:var(--border)] focus:border-[var(--accent-gold)] transition-colors"
                />
                <button
                  type="button"
                  onClick={() => onUpdateItem(item.tempId, 'requires_photo', !item.requires_photo)}
                  title="Require photo"
                  className={item.requires_photo ? 'p-1 rounded transition-colors' : 'p-1 rounded transition-colors text-muted-themed hover:text-secondary-themed'}
                  style={item.requires_photo ? { color: 'var(--accent-gold)', background: 'var(--accent-gold-dim)' } : undefined}
                >
                  <Camera className="w-4 h-4" />
                </button>
                <button type="button" onClick={() => onRemoveItem(item.tempId)} className="text-muted-themed hover:text-[var(--accent-red)] transition-colors p-1">
                  <Trash2 className="w-3.5 h-3.5" />
                </button>
              </div>
            ))}
          </div>

          <button
            type="button"
            onClick={onAddItem}
            className="w-full flex items-center justify-center gap-2 py-2 text-sm text-muted-themed hover:text-[var(--accent-gold)] hover:bg-[var(--accent-gold-dim)] rounded-lg transition-colors border border-dashed border-themed"
          >
            <Plus className="w-3.5 h-3.5" /> Add task
          </button>

          {canManage && (
            <div className="flex items-center gap-3 pt-2 flex-wrap">
              <Button
                variant="secondary"
                onClick={() => onSave(room.name !== initialName)}
                disabled={saving}
                className="text-sm inline-flex items-center gap-1.5"
              >
                {saveButtonLabel(saving, saved)}
              </Button>

              {!room.isSystem && (
                confirmDelete ? (
                  <div className="flex items-center gap-2 text-sm">
                    <span className="text-muted-themed">Delete this room template?</span>
                    <Button variant="secondary" onClick={onDelete} disabled={saving} className="text-xs" style={{ color: 'var(--accent-red)' }}>
                      Yes, delete
                    </Button>
                    <Button variant="ghost" onClick={() => setConfirmDelete(false)} className="text-xs">Cancel</Button>
                  </div>
                ) : (
                  <Button
                    variant="ghost"
                    onClick={() => setConfirmDelete(true)}
                    disabled={saving}
                    className="text-sm ml-auto text-muted-themed hover:text-[var(--accent-red)]"
                  >
                    Delete Room Template
                  </Button>
                )
              )}
            </div>
          )}
        </div>
      )}
    </div>
  )
}
