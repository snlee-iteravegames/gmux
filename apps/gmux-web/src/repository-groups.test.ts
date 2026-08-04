import { describe, expect, it } from 'vitest'
import type { Folder, FolderUrgency } from './types'
import { deriveRepositorySidebarItems, repositoryGroupSummary } from './repository-groups'

function folder(
  key: string,
  repositoryKey?: string,
  peer?: string,
  urgency: FolderUrgency = 'idle',
  visibleCount = 1,
): Folder {
  return {
    key,
    slug: key,
    name: key,
    peer,
    probe: repositoryKey ? {
      git: {
        branch: key,
        dirty_count: 0,
        repository_key: repositoryKey,
        repository_name: 'shared-repo',
      },
    } : undefined,
    aggregate: { urgency, visibleCount },
    sessions: [],
  }
}

describe('repository sidebar grouping', () => {
  it('groups two linked worktree folders while preserving lane order and identity', () => {
    const first = folder('main', 'repo-1', undefined, 'idle', 2)
    const unrelated = folder('other', 'repo-2')
    const second = folder('feature', 'repo-1', undefined, 'error', 1)
    const items = deriveRepositorySidebarItems([first, unrelated, second])

    expect(items).toHaveLength(2)
    expect(items[0].kind).toBe('repository')
    if (items[0].kind !== 'repository') return
    expect(items[0].lanes).toEqual([first, second])
    expect(items[0].aggregate).toEqual({ urgency: 'error', visibleCount: 3 })
    expect(repositoryGroupSummary(items[0])).toBe('2 lanes, 3 visible sessions, error')
    expect(items[1]).toEqual({ kind: 'folder', folder: unrelated })
  })

  it('does not group a single folder, missing legacy keys, or matching keys from different hosts', () => {
    const legacy = folder('legacy')
    const local = folder('local', 'same-key')
    const peer = folder('peer', 'same-key', 'tower')
    const items = deriveRepositorySidebarItems([legacy, local, peer])

    expect(items.map(item => item.kind)).toEqual(['folder', 'folder', 'folder'])
    expect(items.map(item => item.kind === 'folder' ? item.folder : null))
      .toEqual([legacy, local, peer])
  })

  it('keeps existing fallback folder ordering when no repository is groupable', () => {
    const folders = [folder('first'), folder('second', 'only-one'), folder('third')]
    expect(deriveRepositorySidebarItems(folders).map(item =>
      item.kind === 'folder' ? item.folder.key : item.key,
    )).toEqual(['first', 'second', 'third'])
  })
})
