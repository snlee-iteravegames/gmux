import { describe, expect, it } from 'vitest'
import type { VNode } from 'preact'
import { FolderProbeMetadata, folderProbeText } from './folder-probe'

const probe = {
  git: {
    branch: 'feature/probes', dirty_count: 3,
    upstream: 'origin/main', ahead: 2, behind: 1,
  },
  pr: { number: 42, status: 'open', url: 'https://example.com/pr/42' },
  scripts: [
    { id: 'ci', label: 'CI', value: 'passing', status: 'success' as const, url: 'https://example.com/ci' },
    { id: 'deploy', label: 'Deploy', value: 'staging', status: 'warning' as const },
  ],
}

describe('folder probe metadata render helper', () => {
  it('orders git, dirty count, PR, and script metadata', () => {
    expect(folderProbeText(probe)).toEqual([
      'feature/probes',
      '3 dirty',
      'origin/main ↑2 ↓1',
      '#42 open',
      'CI passing',
      'Deploy staging',
    ])
  })

  it('omits the metadata row when no probe result exists', () => {
    expect(FolderProbeMetadata({ probe: undefined })).toBeNull()
  })

  it('renders the compact metadata container for probe results', () => {
    const vnode = FolderProbeMetadata({ probe, className: 'test-probe' }) as VNode
    expect(vnode.type).toBe('div')
    const props = vnode.props as unknown as { class: string; 'aria-label': string }
    expect(props.class).toContain('folder-probe-metadata')
    expect(props.class).toContain('test-probe')
    expect(props['aria-label']).toContain('origin/main ↑2 ↓1')
  })
})
