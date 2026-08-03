import type { ILink, ILinkProvider, Terminal } from '@xterm/xterm'

export interface TerminalFileTarget {
  path: string
  line?: number
}

export interface TerminalFileMatch extends TerminalFileTarget {
  text: string
  startIndex: number
  endIndex: number
}

const TOKEN_PATTERN = /\S+/g
const LEADING_PUNCTUATION = /^[([{<'"`]+/
const TRAILING_PUNCTUATION = /[\])}>'"`,;.!?]+$/
const URI_SCHEME = /^[a-z][a-z0-9+.-]*:/i
const WINDOWS_ABSOLUTE_PATH = /^[a-z]:[\\/]/i
const BARE_FILE_PATH = /^(?:[^/\s]+\/)*[^/\s]+\.[a-z0-9][a-z0-9._-]*$/i

function trimToken(raw: string): { text: string, offset: number } {
  const leading = raw.match(LEADING_PUNCTUATION)?.[0].length ?? 0
  let text = raw.slice(leading)

  // A colon can be meaningful as :line[:column]. All other terminal
  // punctuation belongs to the surrounding prose rather than the path.
  while (TRAILING_PUNCTUATION.test(text)) text = text.replace(TRAILING_PUNCTUATION, '')
  if (text.endsWith(':')) text = text.slice(0, -1)

  return { text, offset: leading }
}

/** Parse a rendered terminal token into the path understood by the preview API. */
export function parseTerminalFileTarget(text: string): TerminalFileTarget | null {
  if (!text || text.includes('@') || /^www\./i.test(text)) return null
  if (URI_SCHEME.test(text) || WINDOWS_ABSOLUTE_PATH.test(text)) return null

  let path = text
  let line: number | undefined
  const location = text.match(/^(.*?):(\d+)(?::\d+)?$/)
  if (location) {
    path = location[1]
    const parsedLine = Number(location[2])
    if (!Number.isSafeInteger(parsedLine) || parsedLine < 1) return null
    line = parsedLine
  }

  const isExplicitPath = path.startsWith('./')
    || path.startsWith('../')
    || path.startsWith('/')
    || path.startsWith('~/')
  if (!isExplicitPath && !BARE_FILE_PATH.test(path)) return null

  return line === undefined ? { path } : { path, line }
}

/** Find local file-looking tokens without claiming URL, URI, or email text. */
export function findTerminalFileLinks(lineText: string): TerminalFileMatch[] {
  const matches: TerminalFileMatch[] = []
  for (const token of lineText.matchAll(TOKEN_PATTERN)) {
    const raw = token[0]
    const rawStart = token.index ?? 0
    const { text, offset } = trimToken(raw)
    const target = parseTerminalFileTarget(text)
    if (!target) continue

    const startIndex = rawStart + offset
    matches.push({
      ...target,
      text,
      startIndex,
      endIndex: startIndex + text.length,
    })
  }
  return matches
}

/**
 * Create a provider after WebLinksAddon so normal URLs keep first refusal.
 * OSC 8 links remain handled by xterm's built-in link handler.
 */
export function createTerminalFileLinkProvider(
  terminal: Terminal,
  onActivate: (target: TerminalFileTarget) => void,
): ILinkProvider {
  return {
    provideLinks(bufferLineNumber, callback) {
      const buffer = terminal.buffer.active
      const requestedIndex = bufferLineNumber - 1
      const requestedLine = buffer.getLine(requestedIndex)
      if (!requestedLine) {
        callback(undefined)
        return
      }

      // xterm stores a visually wrapped command/output line as multiple buffer
      // lines. Rebuild that logical line so long workspace paths remain one
      // clickable link even when the sidebar makes the terminal narrow.
      let firstIndex = requestedIndex
      while (firstIndex > 0 && buffer.getLine(firstIndex)?.isWrapped) firstIndex--
      let lastIndex = requestedIndex
      while (buffer.getLine(lastIndex + 1)?.isWrapped) lastIndex++

      let logicalText = ''
      for (let index = firstIndex; index <= lastIndex; index++) {
        const line = buffer.getLine(index)
        if (!line) break
        logicalText += line.translateToString(index === lastIndex)
      }

      const links: ILink[] = findTerminalFileLinks(logicalText)
        .map(match => {
          const lastCharacterIndex = match.endIndex - 1
          const startY = firstIndex + Math.floor(match.startIndex / terminal.cols) + 1
          const endY = firstIndex + Math.floor(lastCharacterIndex / terminal.cols) + 1
          return {
            text: match.text,
            range: {
              start: { x: (match.startIndex % terminal.cols) + 1, y: startY },
              end: { x: (lastCharacterIndex % terminal.cols) + 1, y: endY },
            },
            activate: () => onActivate({ path: match.path, line: match.line }),
          }
        })
        // xterm asks providers for the hovered buffer row. Only return links
        // that actually cross that row, while preserving their full range.
        .filter(link => bufferLineNumber >= link.range.start.y && bufferLineNumber <= link.range.end.y)
      callback(links.length > 0 ? links : undefined)
    },
  }
}
