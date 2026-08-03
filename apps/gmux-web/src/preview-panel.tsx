import type { ComponentChildren, VNode } from 'preact'
import { useEffect, useRef, useState } from 'preact/hooks'
import type { Session } from './types'
import type { TerminalFileTarget } from './terminal-file-link'

interface PreviewPanelProps {
  session: Session
  target: TerminalFileTarget
  onClose: () => void
}

type PreviewState =
  | { kind: 'loading' }
  | { kind: 'error', message: string }
  | { kind: 'text', text: string, markdown: boolean }
  | { kind: 'image', url: string, contentType: string }

const IMAGE_CONTENT_TYPES = new Set([
  'image/png',
  'image/jpeg',
  'image/gif',
  'image/webp',
])
const MARKDOWN_EXTENSION = /\.(?:md|markdown|mdown)$/i

export function previewRequestUrl(sessionId: string, path: string): string {
  return `/v1/sessions/${encodeURIComponent(sessionId)}/preview?path=${encodeURIComponent(path)}`
}

export async function previewErrorMessage(response: Response): Promise<string> {
  try {
    const body = await response.text()
    if (body) {
      const json = JSON.parse(body) as {
        message?: unknown
        error?: unknown
      }
      if (typeof json.message === 'string' && json.message) return json.message
      if (typeof json.error === 'string' && json.error) return json.error
      if (json.error && typeof json.error === 'object') {
        const nestedMessage = (json.error as { message?: unknown }).message
        if (typeof nestedMessage === 'string' && nestedMessage) return nestedMessage
      }
    }
  } catch {
    // The endpoint normally returns JSON errors, but proxies may not.
  }
  return response.statusText || `Request failed (HTTP ${response.status})`
}

function safeExternalHref(href: string): string | null {
  try {
    const url = new URL(href)
    return url.protocol === 'http:' || url.protocol === 'https:' ? href : null
  } catch {
    return null
  }
}

/** Render a deliberately small inline Markdown subset as escaped Preact nodes. */
export function renderMarkdownInline(text: string): ComponentChildren[] {
  const nodes: ComponentChildren[] = []
  const pattern = /(`[^`\n]+`)|\[([^\]\n]+)\]\(([^)\s]+)\)/g
  let cursor = 0

  for (const match of text.matchAll(pattern)) {
    const index = match.index ?? 0
    if (index > cursor) nodes.push(text.slice(cursor, index))
    if (match[1]) {
      nodes.push(<code>{match[1].slice(1, -1)}</code>)
    } else {
      const label = match[2]
      const href = safeExternalHref(match[3])
      nodes.push(href
        ? <a href={href} target="_blank" rel="noopener noreferrer">{label}</a>
        : match[0])
    }
    cursor = index + match[0].length
  }

  if (cursor < text.length) nodes.push(text.slice(cursor))
  return nodes
}

function MarkdownPreview({ text }: { text: string }) {
  const blocks: VNode[] = []
  const lines = text.replace(/\r\n?/g, '\n').split('\n')
  let paragraph: string[] = []
  let listItems: Array<{ ordered: boolean, text: string }> = []
  let code: string[] | null = null
  let codeKey = 0

  const flushParagraph = () => {
    if (paragraph.length === 0) return
    const value = paragraph.join(' ')
    blocks.push(<p key={`p-${blocks.length}`}>{renderMarkdownInline(value)}</p>)
    paragraph = []
  }
  const flushList = () => {
    if (listItems.length === 0) return
    const ordered = listItems[0].ordered
    const Tag = ordered ? 'ol' : 'ul'
    blocks.push(
      <Tag key={`list-${blocks.length}`}>
        {listItems.map((item, index) => <li key={index}>{renderMarkdownInline(item.text)}</li>)}
      </Tag>,
    )
    listItems = []
  }
  const flushCode = () => {
    if (code === null) return
    blocks.push(<pre class="preview-markdown-code" key={`code-${codeKey++}`}><code>{code.join('\n')}</code></pre>)
    code = null
  }

  for (const line of lines) {
    if (line.startsWith('```')) {
      flushParagraph()
      flushList()
      if (code === null) code = []
      else flushCode()
      continue
    }
    if (code !== null) {
      code.push(line)
      continue
    }

    const heading = line.match(/^(#{1,6})\s+(.+)$/)
    if (heading) {
      flushParagraph()
      flushList()
      const content = renderMarkdownInline(heading[2])
      const key = `h-${blocks.length}`
      switch (heading[1].length) {
        case 1: blocks.push(<h1 key={key}>{content}</h1>); break
        case 2: blocks.push(<h2 key={key}>{content}</h2>); break
        case 3: blocks.push(<h3 key={key}>{content}</h3>); break
        case 4: blocks.push(<h4 key={key}>{content}</h4>); break
        case 5: blocks.push(<h5 key={key}>{content}</h5>); break
        default: blocks.push(<h6 key={key}>{content}</h6>)
      }
      continue
    }

    const listItem = line.match(/^\s*(?:(\d+)\.|[-*+])\s+(.+)$/)
    if (listItem) {
      flushParagraph()
      const ordered = listItem[1] !== undefined
      if (listItems.length > 0 && listItems[0].ordered !== ordered) flushList()
      listItems.push({ ordered, text: listItem[2] })
      continue
    }

    const quote = line.match(/^>\s?(.*)$/)
    if (quote) {
      flushParagraph()
      flushList()
      blocks.push(<blockquote key={`q-${blocks.length}`}>{renderMarkdownInline(quote[1])}</blockquote>)
      continue
    }

    if (line.trim() === '') {
      flushParagraph()
      flushList()
    } else {
      paragraph.push(line.trim())
    }
  }
  flushParagraph()
  flushList()
  flushCode()

  return <div class="preview-markdown">{blocks}</div>
}

function TextPreview({ text, line }: { text: string, line?: number }) {
  const highlightedRef = useRef<HTMLSpanElement>(null)
  const lines = text.replace(/\r\n?/g, '\n').split('\n')

  useEffect(() => {
    if (!line || !highlightedRef.current) return
    highlightedRef.current.scrollIntoView({ block: 'center' })
  }, [line, text])

  return (
    <pre class="preview-code">
      {lines.map((value, index) => {
        const number = index + 1
        const highlighted = number === line
        return (
          <span
            class={`preview-code-line${highlighted ? ' preview-code-line-highlighted' : ''}`}
            data-line={number}
            key={number}
            ref={highlighted ? highlightedRef : undefined}
          >
            <span class="preview-line-number" aria-hidden="true">{number}</span>
            <span class="preview-line-text">{value || ' '}</span>
          </span>
        )
      })}
    </pre>
  )
}

export function PreviewPanel({ session, target, onClose }: PreviewPanelProps) {
  const [state, setState] = useState<PreviewState>({ kind: 'loading' })
  const overlayRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const overlay = overlayRef.current
    const shell = overlay?.parentElement
    if (!overlay || !shell) return

    const previousOverflow = shell.style.overflow
    const positionOverViewport = () => {
      overlay.style.top = `${shell.scrollTop}px`
      overlay.style.left = `${shell.scrollLeft}px`
      overlay.style.width = `${shell.clientWidth}px`
      overlay.style.height = `${shell.clientHeight}px`
    }
    positionOverViewport()
    shell.style.overflow = 'hidden'
    const observer = new ResizeObserver(positionOverViewport)
    observer.observe(shell)
    return () => {
      observer.disconnect()
      shell.style.overflow = previousOverflow
    }
  }, [])

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return
      event.preventDefault()
      event.stopPropagation()
      onClose()
    }
    window.addEventListener('keydown', onKeyDown, true)
    return () => window.removeEventListener('keydown', onKeyDown, true)
  }, [onClose])

  useEffect(() => {
    if (session.peer) {
      setState({ kind: 'error', message: 'File preview is not supported for remote sessions.' })
      return
    }

    const controller = new AbortController()
    let objectUrl: string | null = null
    setState({ kind: 'loading' })

    void fetch(previewRequestUrl(session.id, target.path), { signal: controller.signal })
      .then(async response => {
        if (!response.ok) throw new Error(await previewErrorMessage(response))

        const contentType = response.headers.get('content-type')?.split(';', 1)[0].trim().toLowerCase() ?? ''
        if (IMAGE_CONTENT_TYPES.has(contentType)) {
          const blob = await response.blob()
          if (controller.signal.aborted) return
          objectUrl = URL.createObjectURL(blob)
          setState({ kind: 'image', url: objectUrl, contentType })
          return
        }
        if (contentType === 'text/plain') {
          const text = await response.text()
          if (controller.signal.aborted) return
          setState({
            kind: 'text',
            text,
            markdown: MARKDOWN_EXTENSION.test(target.path),
          })
          return
        }
        throw new Error('This file type cannot be previewed safely.')
      })
      .catch(error => {
        if (controller.signal.aborted) return
        setState({ kind: 'error', message: error instanceof Error ? error.message : 'File preview failed.' })
      })

    return () => {
      controller.abort()
      if (objectUrl) URL.revokeObjectURL(objectUrl)
    }
  }, [session.id, session.peer, target.path])

  return (
    <div ref={overlayRef} class="preview-overlay" role="dialog" aria-modal="true" aria-label={`Preview ${target.path}`}>
      <section class="preview-panel">
        <header class="preview-header">
          <div class="preview-title" title={target.path}>{target.path}</div>
          <button type="button" class="preview-close" onClick={onClose} aria-label="Close preview">Close</button>
        </header>
        <div class="preview-body">
          {state.kind === 'loading' && <div class="preview-status">Loading preview…</div>}
          {state.kind === 'error' && <div class="preview-status preview-error">{state.message}</div>}
          {state.kind === 'text' && (state.markdown
            ? <MarkdownPreview text={state.text} />
            : <TextPreview text={state.text} line={target.line} />)}
          {state.kind === 'image' && (
            <div class="preview-image-wrap">
              <img src={state.url} alt={`Preview of ${target.path}`} />
            </div>
          )}
        </div>
      </section>
    </div>
  )
}
