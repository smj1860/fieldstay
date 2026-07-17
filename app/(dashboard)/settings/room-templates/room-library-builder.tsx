'use client'

import { useState, useTransition } from 'react'
import { Plus, Trash2, ChevronUp, ChevronDown, ChevronRight, Camera, Check, Home } from 'lucide-react'
import { Button } from '@/components/ui/Button'
import { InlineAlert } from '@/components/ui/InlineAlert'
import {
  createRoomTemplate,
  renameRoomTemplate,
  deleteRoomTemplate,
  saveRoomTemplateItems,
  type RoomTemplateItemInput,
} from './actions'

interface ItemState {
  tempId: string
  task: string
  requires_photo: boolean
  notes: string
}

interface RoomState {
  id: string
  name: string
  items: ItemState[]
}

function makeId() {
  if (typeof window === 'undefined') return 'ssr'
  return crypto.randomUUID()
}

function toItemState(item: { task: string; requires_photo: boolean; notes: string }): ItemState {
  return { tempId: makeId(), task: item.task, requires_photo: item.requires_photo, notes: item.notes }
}

export function RoomLibraryBuilder({
  initialRooms,
  canManage,
}: {
  initialRooms: Array<{ id: string; name: string; items: Array<{ id: string; task: string; requires_photo: boolean; notes: string }> }>
  canManage: boolean
}) {
  const [rooms, setRooms] = useState<RoomState[]>(() =>
    initialRooms.map((r) => ({ id: r.id, name: r.name, items: r.items.map(toItemState) }))
  )
  const [expanded, setExpanded] = useState<Set<string>>(new Set())
  const [newRoomName, setNewRoomName] = useState('')
  const [creating, startCreate] = useTransition()
  const [error, setError] = useState<string | null>(null)
  const [savedRoomId, setSavedRoomId] = useState<string | null>(null)

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
      setRooms((prev) => [...prev, { id: result.id!, name, items: [] }])
      setExpanded((prev) => new Set(prev).add(result.id!))
      setNewRoomName('')
      setError(null)
    })
  }

  const updateRoomName = (roomId: string, name: string) => {
    setRooms((prev) => prev.map((r) => (r.id === roomId ? { ...r, name } : r)))
  }

  const addItem = (roomId: string) => {
    setRooms((prev) => prev.map((r) =>
      r.id === roomId
        ? { ...r, items: [...r.items, { tempId: makeId(), task: '', requires_photo: false, notes: '' }] }
        : r
    ))
  }

  const removeItem = (roomId: string, itemTempId: string) => {
    setRooms((prev) => prev.map((r) =>
      r.id === roomId ? { ...r, items: r.items.filter((i) => i.tempId !== itemTempId) } : r
    ))
  }

  const updateItem = (roomId: string, itemTempId: string, field: keyof ItemState, value: unknown) => {
    setRooms((prev) => prev.map((r) =>
      r.id === roomId
        ? { ...r, items: r.items.map((i) => (i.tempId === itemTempId ? { ...i, [field]: value } : i)) }
        : r
    ))
  }

  const moveItem = (roomId: string, itemTempId: string, dir: -1 | 1) => {
    setRooms((prev) => prev.map((r) => {
      if (r.id !== roomId) return r
      const idx = r.items.findIndex((i) => i.tempId === itemTempId)
      const next = [...r.items]
      const swap = idx + dir
      if (swap < 0 || swap >= next.length) return r
      ;[next[idx], next[swap]] = [next[swap], next[idx]]
      return { ...r, items: next }
    }))
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
            onAddItem={() => addItem(room.id)}
            onRemoveItem={(itemTempId) => removeItem(room.id, itemTempId)}
            onUpdateItem={(itemTempId, field, value) => updateItem(room.id, itemTempId, field, value)}
            onMoveItem={(itemTempId, dir) => moveItem(room.id, itemTempId, dir)}
            onSave={(nameChanged) => {
              startCreate(async () => {
                setError(null)
                if (nameChanged) {
                  const renameResult = await renameRoomTemplate(room.id, room.name)
                  if (renameResult.error) { setError(renameResult.error); return }
                }
                const itemsResult = await saveRoomTemplateItems(
                  room.id,
                  room.items.map((item, i): RoomTemplateItemInput => ({
                    task:           item.task,
                    requires_photo: item.requires_photo,
                    notes:          item.notes,
                    sort_order:     i,
                  }))
                )
                if (itemsResult.error) { setError(itemsResult.error); return }
                setSavedRoomId(room.id)
                setTimeout(() => setSavedRoomId(null), 2000)
              })
            }}
            onDelete={() => {
              startCreate(async () => {
                setError(null)
                const result = await deleteRoomTemplate(room.id)
                if (result.error) { setError(result.error); return }
                setRooms((prev) => prev.filter((r) => r.id !== room.id))
              })
            }}
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
  onAddItem,
  onRemoveItem,
  onUpdateItem,
  onMoveItem,
  onSave,
  onDelete,
}: {
  room: RoomState
  isOpen: boolean
  canManage: boolean
  saved: boolean
  saving: boolean
  onToggle: () => void
  onNameChange: (name: string) => void
  onAddItem: () => void
  onRemoveItem: (itemTempId: string) => void
  onUpdateItem: (itemTempId: string, field: keyof ItemState, value: unknown) => void
  onMoveItem: (itemTempId: string, dir: -1 | 1) => void
  onSave: (nameChanged: boolean) => void
  onDelete: () => void
}) {
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
                  onClick={() => onUpdateItem(item.tempId, 'requires_photo', !item.requires_photo)}
                  title="Require photo"
                  className={item.requires_photo ? 'p-1 rounded transition-colors' : 'p-1 rounded transition-colors text-muted-themed hover:text-secondary-themed'}
                  style={item.requires_photo ? { color: 'var(--accent-gold)', background: 'var(--accent-gold-dim)' } : undefined}
                >
                  <Camera className="w-4 h-4" />
                </button>
                <button onClick={() => onRemoveItem(item.tempId)} className="text-muted-themed hover:text-red-500 transition-colors p-1">
                  <Trash2 className="w-3.5 h-3.5" />
                </button>
              </div>
            ))}
          </div>

          <button
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
                {saving ? 'Saving…' : saved ? <><Check className="w-4 h-4" /> Saved</> : 'Save Room'}
              </Button>

              {confirmDelete ? (
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
                  className="text-sm ml-auto text-muted-themed hover:text-red-500"
                >
                  Delete Room Template
                </Button>
              )}
            </div>
          )}
        </div>
      )}
    </div>
  )
}
