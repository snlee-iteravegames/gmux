import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { attachMobileInputHandler, diffTextareaValues } from './mobile-input'

type Listener = (ev: any) => void

function fakeTarget() {
  const listeners = new Map<string, Set<Listener>>()
  return {
    value: '',
    selectionStart: 0,
    selectionEnd: 0,
    addEventListener(type: string, fn: Listener) {
      if (!listeners.has(type)) listeners.set(type, new Set())
      listeners.get(type)!.add(fn)
    },
    removeEventListener(type: string, fn: Listener) {
      listeners.get(type)?.delete(fn)
    },
    dispatch(type: string, props: Record<string, unknown> = {}) {
      let stopped = false
      let defaultPrevented = false
      const ev = {
        type,
        target: this,
        cancelable: true,
        key: '',
        keyCode: 0,
        inputType: '',
        data: null,
        isComposing: false,
        ctrlKey: false,
        altKey: false,
        metaKey: false,
        stopPropagation() { stopped = true },
        stopImmediatePropagation() { stopped = true },
        preventDefault() { if (this.cancelable) defaultPrevented = true },
        ...props,
      }
      for (const fn of listeners.get(type) ?? []) fn(ev)
      return { stopped, defaultPrevented }
    },
  }
}

class FakeMediaQuery {
  matches = true
  private listeners = new Set<() => void>()
  addEventListener(_type: string, fn: () => void) { this.listeners.add(fn) }
  removeEventListener(_type: string, fn: () => void) { this.listeners.delete(fn) }
  set(value: boolean) {
    this.matches = value
    for (const fn of this.listeners) fn()
  }
}

describe('diffTextareaValues', () => {
  it.each([
    ['', 'ㅎ', 'ㅎ'],
    ['ㅎ', '하', '\x7f하'],
    ['한글', '한', '\x7f'],
    ['wrld', 'world', '\x7f'.repeat(3) + 'orld'],
    ['the teh quick', 'the the quick', '\x7f'.repeat(8) + 'he quick'],
    ['😀', '', '\x7f'],
    ['a😀한', 'a', '\x7f\x7f'],
  ])('transforms %j into %j', (oldValue, newValue, expected) => {
    expect(diffTextareaValues(oldValue, newValue)).toBe(expected)
  })
})

describe('attachMobileInputHandler', () => {
  let textarea: ReturnType<typeof fakeTarget>
  let container: ReturnType<typeof fakeTarget>
  let media: FakeMediaQuery
  let sent: string[]
  let dispose: () => void

  const activateWithComposition = () => container.dispatch('compositionstart', {
    target: textarea,
    data: '',
  })

  const activateWith229 = (key = 'Unidentified') => container.dispatch('keydown', {
    target: textarea,
    key,
    keyCode: 229,
  })

  const editTo = (
    inputType: string,
    newValue: string,
    options: { data?: string | null; composing?: boolean } = {},
  ) => {
    const data = options.data ?? null
    const isComposing = options.composing ?? false
    const before = container.dispatch('beforeinput', {
      target: textarea,
      inputType,
      data,
      isComposing,
    })
    if (!before.defaultPrevented) {
      textarea.value = newValue
      textarea.selectionStart = textarea.selectionEnd = newValue.length
    }
    const input = container.dispatch('input', {
      target: textarea,
      inputType,
      data,
      isComposing,
    })
    return { before, input }
  }

  beforeEach(() => {
    textarea = fakeTarget()
    container = fakeTarget()
    media = new FakeMediaQuery()
    sent = []
    vi.stubGlobal('window', { matchMedia: () => media })
    dispose = attachMobileInputHandler(
      { textarea } as any,
      container as any,
      data => sent.push(data),
    )
  })

  afterEach(() => {
    dispose()
    vi.unstubAllGlobals()
    vi.useRealTimers()
  })

  it('leaves ordinary input passive before an IME signal', () => {
    const result = editTo('insertText', 'a', { data: 'a' })
    expect(result.input.stopped).toBe(false)
    expect(sent).toEqual([])
  })

  it('handles a compositionless selected replacement on mobile', () => {
    textarea.value = 'wrld'
    textarea.selectionStart = 0
    textarea.selectionEnd = 4
    const result = editTo('insertReplacementText', 'world', { data: 'world' })
    expect(result.input.stopped).toBe(true)
    expect(sent).toEqual(['\x7f'.repeat(3) + 'orld'])
  })

  it('blocks xterm composition events and streams Korean transitions', () => {
    expect(activateWithComposition().stopped).toBe(true)
    expect(container.dispatch('compositionupdate', { target: textarea, data: 'ㅎ' }).stopped).toBe(true)

    editTo('insertCompositionText', 'ㅎ', { data: 'ㅎ', composing: true })
    editTo('insertCompositionText', '하', { data: '하', composing: true })
    editTo('insertCompositionText', '한', { data: '한', composing: true })

    expect(sent).toEqual(['ㅎ', '\x7f하', '\x7f한'])
    expect(container.dispatch('compositionend', { target: textarea, data: '한' }).stopped).toBe(true)
    expect(sent).toHaveLength(3)
  })

  it('sends Space immediately after composition without a second commit', () => {
    activateWithComposition()
    editTo('insertCompositionText', '한', { data: '한', composing: true })
    container.dispatch('compositionend', { target: textarea, data: '한' })
    editTo('insertText', '한 ', { data: ' ' })
    expect(sent).toEqual(['한', ' '])
  })

  it('sends exactly one DEL per removed Korean codepoint', () => {
    textarea.value = '가나다'
    textarea.selectionStart = textarea.selectionEnd = 3
    activateWith229('Backspace')
    editTo('deleteContentBackward', '가나')
    editTo('deleteContentBackward', '가')
    editTo('deleteContentBackward', '')
    expect(sent).toEqual(['\x7f', '\x7f', '\x7f'])
  })

  it('blocks keyCode 229 so xterm cannot schedule its deferred diff', () => {
    const result = activateWith229()
    expect(result.stopped).toBe(true)
    editTo('insertText', '안', { data: '안' })
    expect(sent).toEqual(['안'])
  })

  it('applies Android delete and insert autocorrect as two exact transitions', () => {
    textarea.value = 'helo world'
    textarea.selectionStart = textarea.selectionEnd = textarea.value.length
    activateWith229()

    editTo('deleteContentBackward', 'he world')
    editTo('insertText', 'hello world', { data: 'llo' })

    expect(sent).toEqual([
      '\x7f'.repeat(8) + ' world',
      '\x7f'.repeat(6) + 'llo world',
    ])
    expect(textarea.value).toBe('hello world')
  })

  it('does not lose the first composing input when all earlier IME signals are missing', () => {
    textarea.value = '한'
    textarea.selectionStart = textarea.selectionEnd = 1
    const result = container.dispatch('input', {
      target: textarea,
      inputType: 'insertCompositionText',
      data: '한',
      isComposing: true,
    })
    expect(result.stopped).toBe(true)
    expect(sent).toEqual(['한'])
  })

  it('falls back to the shadow model when beforeinput is missing', () => {
    textarea.value = '안'
    textarea.selectionStart = textarea.selectionEnd = 1
    activateWith229()
    textarea.value = '안녕'
    textarea.selectionStart = textarea.selectionEnd = 2
    const result = container.dispatch('input', {
      target: textarea,
      inputType: 'insertText',
      data: '녕',
    })
    expect(result.stopped).toBe(true)
    expect(sent).toEqual(['녕'])
  })

  it('expires a stale beforeinput snapshot and still aggregates from shadow', () => {
    vi.useFakeTimers()
    textarea.value = '안'
    textarea.selectionStart = textarea.selectionEnd = 1
    activateWith229()
    container.dispatch('beforeinput', {
      target: textarea,
      inputType: 'insertText',
      data: '녕',
    })
    vi.runAllTimers()
    textarea.value = '안녕'
    textarea.selectionStart = textarea.selectionEnd = 2
    container.dispatch('input', {
      target: textarea,
      inputType: 'insertText',
      data: '녕',
    })
    expect(sent).toEqual(['녕'])
  })

  it('sends Enter once from keydown and suppresses a duplicate line-break input', () => {
    vi.useFakeTimers()
    textarea.value = '한'
    textarea.selectionStart = textarea.selectionEnd = 1
    activateWith229()
    const keydown = container.dispatch('keydown', {
      target: textarea,
      key: 'Enter',
      keyCode: 13,
    })
    expect(keydown.stopped).toBe(true)
    expect(keydown.defaultPrevented).toBe(false)

    editTo('insertLineBreak', '\n')
    expect(sent).toEqual(['\r'])
    expect(textarea.value).toBe('')
  })

  it('flushes a final composition change before Enter on keyup fallback', () => {
    textarea.value = '하'
    textarea.selectionStart = textarea.selectionEnd = 1
    activateWith229()
    container.dispatch('keydown', {
      target: textarea,
      key: 'Enter',
      keyCode: 13,
    })
    // Final native composition mutation and Enter's default newline arrived
    // without their own input events.
    textarea.value = '한\n'
    textarea.selectionStart = textarea.selectionEnd = 2
    container.dispatch('keyup', {
      target: textarea,
      key: 'Enter',
      keyCode: 13,
    })
    expect(sent).toEqual(['\x7f한', '\r'])
  })

  it('handles line break when no keydown event is delivered', () => {
    textarea.value = '한'
    textarea.selectionStart = textarea.selectionEnd = 1
    activateWithComposition()
    const result = container.dispatch('beforeinput', {
      target: textarea,
      inputType: 'insertParagraph',
      data: null,
    })
    expect(result.stopped).toBe(true)
    expect(result.defaultPrevented).toBe(true)
    expect(sent).toEqual(['\r'])
    expect(textarea.value).toBe('')
  })

  it('lets modified shortcuts and navigation remain xterm-owned', () => {
    activateWith229()
    const shortcut = container.dispatch('keydown', {
      target: textarea,
      key: 'c',
      keyCode: 67,
      ctrlKey: true,
    })
    const arrow = container.dispatch('keydown', {
      target: textarea,
      key: 'ArrowLeft',
      keyCode: 37,
    })
    expect(shortcut.stopped).toBe(false)
    expect(arrow.stopped).toBe(false)
    expect(sent).toEqual([])
  })

  it('resets ownership on blur', () => {
    activateWith229()
    textarea.dispatch('blur')
    const result = editTo('insertText', 'a', { data: 'a' })
    expect(result.input.stopped).toBe(false)
    expect(sent).toEqual([])
  })

  it('resets ownership when primary pointer becomes fine', () => {
    activateWith229()
    media.set(false)
    const result = editTo('insertText', 'a', { data: 'a' })
    expect(result.input.stopped).toBe(false)
    expect(sent).toEqual([])
  })

  it('does nothing on desktop', () => {
    dispose()
    media.matches = false
    sent = []
    dispose = attachMobileInputHandler(
      { textarea } as any,
      container as any,
      data => sent.push(data),
    )
    expect(activateWithComposition().stopped).toBe(false)
    const result = editTo('insertReplacementText', 'desktop', { data: 'desktop' })
    expect(result.input.stopped).toBe(false)
    expect(sent).toEqual([])
  })

  it('removes every listener on cleanup', () => {
    dispose()
    dispose = () => {}
    expect(activateWith229().stopped).toBe(false)
    expect(activateWithComposition().stopped).toBe(false)
    const result = editTo('insertText', 'a', { data: 'a', composing: true })
    expect(result.input.stopped).toBe(false)
    expect(sent).toEqual([])
  })

  it('returns a noop without a textarea', () => {
    dispose()
    dispose = attachMobileInputHandler({ textarea: undefined } as any, container as any, vi.fn())
    expect(() => dispose()).not.toThrow()
  })
})
