import { describe, expect, it } from 'vitest'
import {
  SessionEventSchema,
  SessionSchema,
  successEnvelope,
  SessionStatusSchema,
  DirectoryProbePayloadSchema,
} from './index.js'

describe('protocol schemas', () => {
  it('parses session (schema v2)', () => {
    const result = SessionSchema.parse({
      id: 'sess-1',
      kind: 'pi',
      alive: true,
      pid: 12345,
      title: 'test session',
      status: { label: 'thinking', working: true },
      terminal_cols: 120,
      terminal_rows: 40,
    })

    expect(result.id).toBe('sess-1')
    expect(result.alive).toBe(true)
    expect(result.status?.working).toBe(true)
    expect(result.status?.label).toBe('thinking')
    expect(result.terminal_cols).toBe(120)
    expect(result.terminal_rows).toBe(40)
  })

  it('parses session with null status', () => {
    const result = SessionSchema.parse({
      id: 'sess-2',
      kind: 'generic',
      alive: false,
      status: null,
    })

    expect(result.status).toBeNull()
    expect(result.alive).toBe(false)
  })

  it('validates session-upsert event', () => {
    const event = SessionEventSchema.parse({
      type: 'session-upsert',
      id: 'sess-1',
      session: {
        id: 'sess-1',
        kind: 'pi',
        alive: true,
        status: { label: 'running', working: true },
      },
    })

    expect(event.type).toBe('session-upsert')
    if (event.type === 'session-upsert') {
      expect(event.session.alive).toBe(true)
    }
  })

  it('validates session-remove event', () => {
    const event = SessionEventSchema.parse({
      type: 'session-remove',
      id: 'sess-1',
    })
    expect(event.type).toBe('session-remove')
  })

  it('builds typed success envelopes', () => {
    const Schema = successEnvelope(SessionStatusSchema)
    const parsed = Schema.parse({ ok: true, data: { label: 'test', working: false } })
    expect(parsed.data.label).toBe('test')
  })

  it('parses optional directory probes on projects data and snapshot world', () => {
    const payload = DirectoryProbePayloadSchema.parse({
      projects: [],
      directory_probes: {
        '/Users/lee/Workspace/gmux': {
          git: {
            branch: 'main', dirty_count: 2,
            repository_key: 'opaque-repository-key', repository_name: 'gmux',
            upstream: 'origin/main', ahead: 3, behind: 1,
          },
          pr: { number: 42, status: 'open', url: 'https://example.com/pr/42' },
          scripts: [{
            id: 'ci', label: 'CI', value: 'passing', status: 'success',
            url: 'https://example.com/actions',
          }],
        },
      },
    })

    const git = payload.directory_probes?.['/Users/lee/Workspace/gmux'].git
    expect(git?.dirty_count).toBe(2)
    expect(git?.repository_key).toBe('opaque-repository-key')
    expect(git?.repository_name).toBe('gmux')
    expect(git?.upstream).toBe('origin/main')
    expect(git?.ahead).toBe(3)
    expect(git?.behind).toBe(1)
    expect(payload.projects).toEqual([])
  })

  it('parses peer-isolated directory probes', () => {
    const payload = DirectoryProbePayloadSchema.parse({
      projects: [],
      peer_directory_probes: {
        tower: {
          '/home/alice/work/gmux': {
            git: { branch: 'remote-main', dirty_count: 1 },
          },
        },
      },
    })
    expect(payload.peer_directory_probes?.tower['/home/alice/work/gmux'].git?.branch)
      .toBe('remote-main')
  })

  it('accepts legacy git probes without repository or upstream metadata', () => {
    const payload = DirectoryProbePayloadSchema.parse({
      directory_probes: { '/work/legacy': { git: { branch: 'main', dirty_count: 0 } } },
    })
    expect(payload.directory_probes?.['/work/legacy'].git?.repository_key).toBeUndefined()
  })

  it('accepts legacy payloads without directory probes', () => {
    const projects = DirectoryProbePayloadSchema.parse({ configured: [] })
    const world = DirectoryProbePayloadSchema.parse({ projects: [] })
    expect(projects.directory_probes).toBeUndefined()
    expect(projects.peer_directory_probes).toBeUndefined()
    expect(world.directory_probes).toBeUndefined()
    expect(world.peer_directory_probes).toBeUndefined()
  })

  it('rejects unknown script statuses', () => {
    const result = DirectoryProbePayloadSchema.safeParse({
      directory_probes: {
        '/work/app': {
          scripts: [{ id: 'ci', label: 'CI', value: '???', status: 'urgent' }],
        },
      },
    })
    expect(result.success).toBe(false)
  })
})
