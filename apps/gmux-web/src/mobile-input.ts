/**
 * Single-owner mobile IME input for xterm.js.
 *
 * Android virtual keyboards edit xterm's hidden textarea as a document. The
 * stock xterm path combines a composition overlay, a deferred composition
 * finalizer, and a second keyCode-229 textarea diff. Samsung Keyboard can
 * therefore show pre-edit text over text already echoed by the PTY, commit a
 * word only on Space, and later resend text that the user deleted.
 *
 * On a coarse-pointer device, once an IME signal is observed, gmux owns the
 * textarea for that focus lifetime. Events are intercepted on an ancestor in
 * capture phase, before xterm's target listeners:
 *
 * - composition events still update the native textarea but never activate
 *   xterm's overlay/finalizer;
 * - keyCode 229 never starts xterm's deferred textarea diff;
 * - each input transforms the previous textarea value into the new value with
 *   DELs plus the changed suffix and sends that transition exactly once.
 *
 * This streams Korean composition updates to the PTY immediately. The shell's
 * normal echo is the only visible representation, so there is no overlay to
 * drift away from the terminal cursor.
 */
import type { Terminal } from '@xterm/xterm'

type SendFn = (data: string) => void

interface EditSnapshot {
  value: string
  inputType: string
}

/** Transform an end-positioned terminal value into a new textarea value. */
export function diffTextareaValues(oldValue: string, newValue: string): string {
  const oldCodepoints = Array.from(oldValue)
  const newCodepoints = Array.from(newValue)
  let prefix = 0
  const limit = Math.min(oldCodepoints.length, newCodepoints.length)
  while (prefix < limit && oldCodepoints[prefix] === newCodepoints[prefix]) prefix++
  return '\x7f'.repeat(oldCodepoints.length - prefix) + newCodepoints.slice(prefix).join('')
}

export function attachMobileInputHandler(
  term: Terminal,
  container: HTMLElement,
  send: SendFn,
): () => void {
  const textarea = term.textarea
  if (!textarea) return () => {/* nothing to tear down */}

  const pointerQuery = window.matchMedia('(pointer: coarse)')
  let isTouchPrimary = pointerQuery.matches
  let streamingIme = false
  let shadowValue = ''
  let snapshot: EditSnapshot | null = null
  let snapshotTimer: ReturnType<typeof setTimeout> | null = null
  let enterKeyPending = false
  let lineBreakHandled = false
  let lineBreakTimer: ReturnType<typeof setTimeout> | null = null

  const clearSnapshot = () => {
    if (snapshotTimer !== null) clearTimeout(snapshotTimer)
    snapshotTimer = null
    snapshot = null
  }

  const clearLineBreak = () => {
    if (lineBreakTimer !== null) clearTimeout(lineBreakTimer)
    lineBreakTimer = null
    enterKeyPending = false
    lineBreakHandled = false
  }

  const resetOwnership = () => {
    streamingIme = false
    shadowValue = ''
    clearSnapshot()
    clearLineBreak()
  }

  const activateStreaming = () => {
    if (!streamingIme) {
      streamingIme = true
      shadowValue = textarea.value
    }
    clearSnapshot()
  }

  const stageSnapshot = (inputType: string) => {
    clearSnapshot()
    const staged = { value: textarea.value, inputType }
    snapshot = staged
    snapshotTimer = setTimeout(() => {
      if (snapshot === staged) snapshot = null
      snapshotTimer = null
    }, 0)
  }

  const beginLineBreak = (ev: Event) => {
    // A keyboard may finalize the last syllable immediately before the line
    // break without a separate input event. Flush the current textarea first.
    // If keydown's default action already inserted a textarea newline, it is
    // only the DOM representation of Enter; never forward it as text as well
    // as the terminal CR.
    const finalValue = textarea.value.replace(/\r?\n$/, '')
    const finalPayload = diffTextareaValues(shadowValue, finalValue)
    if (finalPayload) send(finalPayload)
    if (!lineBreakHandled) send('\r')
    lineBreakHandled = true
    enterKeyPending = false
    clearSnapshot()
    shadowValue = ''
    textarea.value = ''
    textarea.selectionStart = textarea.selectionEnd = 0
    if (ev.cancelable) ev.preventDefault()
    if (lineBreakTimer !== null) clearTimeout(lineBreakTimer)
    lineBreakTimer = setTimeout(() => {
      lineBreakHandled = false
      lineBreakTimer = null
    }, 0)
  }

  const onPointerChange = () => {
    isTouchPrimary = pointerQuery.matches
    if (!isTouchPrimary) resetOwnership()
  }

  const onKeyDown = (ev: KeyboardEvent) => {
    if (!isTouchPrimary) return

    if (ev.keyCode === 229 || ev.isComposing) activateStreaming()
    if (!streamingIme) return

    if (ev.key === 'Enter' || ev.keyCode === 13) {
      // Do not execute the command yet: Samsung may still deliver the final
      // composition input after keydown. beforeinput, input, or keyup commits
      // Enter after that final edit has had a chance to arrive.
      ev.stopPropagation()
      enterKeyPending = true
      return
    }

    // Let terminal shortcuts and navigation remain xterm-owned. Text/editing
    // keys must reach the textarea default action but not xterm's key handler,
    // otherwise keydown and input would both send the same transition.
    if (ev.ctrlKey || ev.altKey || ev.metaKey) {
      resetOwnership()
      return
    }
    const isTextOrEdit = ev.keyCode === 229
      || ev.isComposing
      || ev.key.length === 1
      || ev.key === 'Backspace'
      || ev.key === 'Delete'
    if (isTextOrEdit) {
      ev.stopPropagation()
    } else {
      // Navigation and command keys move terminal state independently of the
      // textarea model. Hand ownership back to xterm before they run.
      resetOwnership()
    }
  }

  const onKeyPress = (ev: KeyboardEvent) => {
    if (!isTouchPrimary || !streamingIme) return
    if (!ev.ctrlKey && !ev.altKey && !ev.metaKey) ev.stopPropagation()
  }

  const onKeyUp = (ev: KeyboardEvent) => {
    if (!isTouchPrimary || !streamingIme) return
    if ((ev.key === 'Enter' || ev.keyCode === 13) && enterKeyPending) {
      ev.stopPropagation()
      beginLineBreak(ev)
      return
    }
    if (ev.keyCode === 229 || ev.isComposing) ev.stopPropagation()
  }

  const onCompositionStart = (ev: CompositionEvent) => {
    if (!isTouchPrimary) return
    activateStreaming()
    ev.stopPropagation()
  }

  const onCompositionEvent = (ev: CompositionEvent) => {
    if (!isTouchPrimary || !streamingIme) return
    ev.stopPropagation()
  }

  const onBeforeInput = (ev: InputEvent) => {
    if (!isTouchPrimary) return
    if (ev.isComposing) activateStreaming()

    if (streamingIme) {
      ev.stopPropagation()
      if (ev.inputType === 'insertLineBreak' || ev.inputType === 'insertParagraph') {
        beginLineBreak(ev)
        return
      }
      stageSnapshot(ev.inputType)
      return
    }

    // iOS may replace a selected word without exposing composition/keyCode229.
    const start = textarea.selectionStart ?? 0
    const end = textarea.selectionEnd ?? start
    if ((ev.inputType === 'insertText' || ev.inputType === 'insertReplacementText') && start < end) {
      stageSnapshot(ev.inputType)
    }
  }

  const onInput = (ev: Event) => {
    if (ev.target !== textarea || !isTouchPrimary) return
    const input = ev as InputEvent

    if (input.isComposing && !streamingIme) {
      // Last-resort activation when compositionstart, keydown 229 and
      // beforeinput were all omitted. input.data describes the first append;
      // reconstruct its pre-edit baseline so that first text is not lost.
      const newValue = textarea.value
      const data = input.data ?? ''
      const baseline = snapshot?.value
        ?? (data && newValue.endsWith(data) ? newValue.slice(0, -data.length) : '')
      streamingIme = true
      shadowValue = baseline
    }

    if (streamingIme) {
      ev.stopPropagation()
      if (input.inputType === 'insertLineBreak' || input.inputType === 'insertParagraph') {
        beginLineBreak(ev)
        return
      }
      if (lineBreakHandled) {
        textarea.value = ''
        textarea.selectionStart = textarea.selectionEnd = 0
        shadowValue = ''
        clearSnapshot()
        return
      }

      const staged = snapshot
      clearSnapshot()
      const oldValue = staged && staged.inputType === input.inputType && staged.value === shadowValue
        ? staged.value
        : shadowValue
      const newValue = textarea.value
      const payload = diffTextareaValues(oldValue, newValue)
      shadowValue = newValue
      if (payload) send(payload)
      return
    }

    if (!snapshot) return
    const staged = snapshot
    clearSnapshot()
    if (staged.inputType !== input.inputType) return
    ev.stopPropagation()
    const payload = diffTextareaValues(staged.value, textarea.value)
    if (payload) send(payload)
  }

  const onBlur = () => resetOwnership()

  pointerQuery.addEventListener('change', onPointerChange)
  container.addEventListener('keydown', onKeyDown, { capture: true })
  container.addEventListener('keypress', onKeyPress, { capture: true })
  container.addEventListener('keyup', onKeyUp, { capture: true })
  container.addEventListener('compositionstart', onCompositionStart, { capture: true })
  container.addEventListener('compositionupdate', onCompositionEvent, { capture: true })
  container.addEventListener('compositionend', onCompositionEvent, { capture: true })
  container.addEventListener('beforeinput', onBeforeInput, { capture: true })
  container.addEventListener('input', onInput, { capture: true })
  textarea.addEventListener('blur', onBlur)

  return () => {
    resetOwnership()
    pointerQuery.removeEventListener('change', onPointerChange)
    container.removeEventListener('keydown', onKeyDown, { capture: true })
    container.removeEventListener('keypress', onKeyPress, { capture: true })
    container.removeEventListener('keyup', onKeyUp, { capture: true })
    container.removeEventListener('compositionstart', onCompositionStart, { capture: true })
    container.removeEventListener('compositionupdate', onCompositionEvent, { capture: true })
    container.removeEventListener('compositionend', onCompositionEvent, { capture: true })
    container.removeEventListener('beforeinput', onBeforeInput, { capture: true })
    container.removeEventListener('input', onInput, { capture: true })
    textarea.removeEventListener('blur', onBlur)
  }
}
