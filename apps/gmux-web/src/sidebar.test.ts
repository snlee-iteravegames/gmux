import { describe, expect, it } from 'vitest'
import {
  canRenameSession,
  clampSidebarWidth,
  SIDEBAR_DEFAULT_WIDTH,
  SIDEBAR_MAX_WIDTH,
  SIDEBAR_MIN_WIDTH,
} from './sidebar'

describe('sidebar pi session rename availability', () => {
  it('shows rename only for a reachable alive pi session', () => {
    expect(canRenameSession({ alive: true, kind: 'pi' })).toBe(true)
    expect(canRenameSession({ alive: false, kind: 'pi' })).toBe(false)
    expect(canRenameSession({ alive: true, kind: 'shell' })).toBe(false)
    expect(canRenameSession({ alive: true, kind: 'codex' })).toBe(false)
    expect(canRenameSession({ alive: true, kind: 'pi' }, true)).toBe(false)
  })
})

describe('clampSidebarWidth', () => {
  it('keeps finite widths within the desktop resize bounds', () => {
    expect(clampSidebarWidth(SIDEBAR_MIN_WIDTH - 100)).toBe(SIDEBAR_MIN_WIDTH)
    expect(clampSidebarWidth(360.4)).toBe(360)
    expect(clampSidebarWidth(SIDEBAR_MAX_WIDTH + 100)).toBe(SIDEBAR_MAX_WIDTH)
  })

  it('falls back to the default for invalid persisted values', () => {
    expect(clampSidebarWidth(Number.NaN)).toBe(SIDEBAR_DEFAULT_WIDTH)
    expect(clampSidebarWidth(Number.POSITIVE_INFINITY)).toBe(SIDEBAR_DEFAULT_WIDTH)
  })
})
