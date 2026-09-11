// Shared "Bedroom" vs "Bedroom 2" numbering convention — used by
// composeSections (apply-master-template.ts), syncChecklistRoomCounts
// (sync-room-counts.ts), and the manual "Insert Rooms from Library" picker
// (checklist-builder.tsx). Plain leaf module (no 'server-only') because the
// picker is a client component.

export function numberedRoomLabel(name: string, count: number, index: number): string {
  return count > 1 ? `${name} ${index}` : name
}

/** Same numbering, but stays null when no Spanish name has been entered. */
export function numberedRoomLabelEs(nameEs: string | null, count: number, index: number): string | null {
  if (!nameEs) return null
  return numberedRoomLabel(nameEs, count, index)
}
