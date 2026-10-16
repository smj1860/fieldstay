// lib/evidence/seal-paths.ts
//
// Which storage path a crew seal may claim for which target row.
//
// The crew seal route authenticates the CREW MEMBER and resolves the target row
// through their RLS client, but the storage path arrives in the request body.
// Without a binding between the two, a crew member could seal ANY photo in the
// org (a PM's, another property's, a guest-facing upload) as evidence for any
// item they are allowed to see, laundering it into a claim packet under their
// own capture. The paths the crew PWA writes are deterministic, so the binding
// is a prefix check per target type. Isomorphic and pure; unit tested.
//
// Writers (keep in step): app/crew/turnovers/[id]/use-turnover-actions.ts
// (item and section photos) and app/crew/_components/discovery-capture-modal.tsx
// (asset photos).

export type CrewSealTarget =
  | { table: 'checklist_instance_items'; orgId: string; turnoverId: string | null; itemId: string }
  | { table: 'checklist_instances';      orgId: string; turnoverId: string | null }
  | { table: 'property_assets';          orgId: string; propertyId: string }

/** The leading part every legitimate path for this target starts with, or null when it cannot be derived. */
export function expectedPathPrefix(target: CrewSealTarget): string | null {
  switch (target.table) {
    case 'checklist_instance_items':
      return target.turnoverId ? `${target.orgId}/turnover-${target.turnoverId}/${target.itemId}-` : null
    case 'checklist_instances':
      return target.turnoverId ? `${target.orgId}/turnover-${target.turnoverId}/section-` : null
    case 'property_assets':
      return `${target.orgId}/asset-discovery/${target.propertyId}/`
  }
}

/** One object key segment: no slash, so the prefix cannot be satisfied by a path that wanders into a sibling folder. */
const FILE_TAIL = /^[A-Za-z0-9._-]+$/

export function pathMatchesTarget(path: string, target: CrewSealTarget): boolean {
  const prefix = expectedPathPrefix(target)
  if (!prefix || !path.startsWith(prefix)) return false
  return FILE_TAIL.test(path.slice(prefix.length))
}
