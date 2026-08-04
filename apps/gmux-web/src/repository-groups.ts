import type { Folder, FolderAggregate, FolderUrgency } from './types'

export interface RepositoryGroup {
  kind: 'repository'
  key: string
  repositoryKey: string
  name: string
  peer?: string
  lanes: Folder[]
  aggregate: FolderAggregate
}

export type RepositorySidebarItem =
  | { kind: 'folder'; folder: Folder }
  | RepositoryGroup

const urgencyRank: Record<FolderUrgency, number> = {
  unread: 0,
  error: 1,
  working: 2,
  idle: 3,
  resumable: 3,
  empty: 4,
}

function repositoryIdentity(folder: Folder): string | undefined {
  const repositoryKey = folder.probe?.git?.repository_key
  if (!repositoryKey) return undefined
  // Repository keys are host-local identities. Never merge an identically
  // shaped payload from another peer with this host's repository.
  return `${folder.peer ?? ''}\0${repositoryKey}`
}

function groupAggregate(lanes: Folder[]): FolderAggregate {
  const visibleCount = lanes.reduce((count, lane) => count + lane.aggregate.visibleCount, 0)
  let urgency: FolderUrgency = 'empty'
  for (const lane of lanes) {
    const rankDelta = urgencyRank[lane.aggregate.urgency] - urgencyRank[urgency]
    if (rankDelta < 0 || (rankDelta === 0 && lane.aggregate.urgency === 'idle')) {
      urgency = lane.aggregate.urgency
    }
  }
  return { urgency, visibleCount }
}

/**
 * Derive repository wrappers without changing Folder identity or persisted
 * project/session ordering. A wrapper occupies the first lane's position and
 * preserves the original relative order of all lanes it contains.
 */
export function deriveRepositorySidebarItems(folders: Folder[]): RepositorySidebarItem[] {
  const members = new Map<string, Folder[]>()
  for (const folder of folders) {
    const identity = repositoryIdentity(folder)
    if (!identity) continue
    const lanes = members.get(identity)
    if (lanes) lanes.push(folder)
    else members.set(identity, [folder])
  }

  const emitted = new Set<string>()
  const items: RepositorySidebarItem[] = []
  for (const folder of folders) {
    const identity = repositoryIdentity(folder)
    const lanes = identity ? members.get(identity) : undefined
    if (!identity || !lanes || lanes.length < 2) {
      items.push({ kind: 'folder', folder })
      continue
    }
    if (emitted.has(identity)) continue
    emitted.add(identity)
    const repositoryKey = folder.probe!.git!.repository_key!
    items.push({
      kind: 'repository',
      key: `repository::${folder.peer ?? ''}::${repositoryKey}`,
      repositoryKey,
      name: lanes.find(lane => lane.probe?.git?.repository_name)?.probe?.git?.repository_name
        || folder.name,
      peer: folder.peer,
      lanes,
      aggregate: groupAggregate(lanes),
    })
  }
  return items
}

export function repositoryGroupSummary(group: RepositoryGroup): string {
  const laneLabel = group.lanes.length === 1 ? 'lane' : 'lanes'
  const sessionLabel = group.aggregate.visibleCount === 1 ? 'visible session' : 'visible sessions'
  return `${group.lanes.length} ${laneLabel}, ${group.aggregate.visibleCount} ${sessionLabel}, ${group.aggregate.urgency}`
}
