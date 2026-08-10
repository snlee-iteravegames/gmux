import { describe, expect, it } from 'vitest'
import { canRenameSession } from './sidebar'

describe('sidebar pi session rename availability', () => {
  it('shows rename only for a reachable alive pi session', () => {
    expect(canRenameSession({ alive: true, kind: 'pi' })).toBe(true)
    expect(canRenameSession({ alive: false, kind: 'pi' })).toBe(false)
    expect(canRenameSession({ alive: true, kind: 'shell' })).toBe(false)
    expect(canRenameSession({ alive: true, kind: 'codex' })).toBe(false)
    expect(canRenameSession({ alive: true, kind: 'pi' }, true)).toBe(false)
  })
})
