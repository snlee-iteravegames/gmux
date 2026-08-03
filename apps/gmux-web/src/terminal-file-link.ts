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
      const bufferLine = terminal.buffer.active.getLine(bufferLineNumber - 1)
      if (!bufferLine) {
        callback(undefined)
        return
      }

      const links: ILink[] = findTerminalFileLinks(bufferLine.translateToString(true)).map(match => ({
        text: match.text,
        range: {
          start: { x: match.startIndex + 1, y: bufferLineNumber },
          end: { x: match.endIndex, y: bufferLineNumber },
        },
        activate: () => onActivate({ path: match.path, line: match.line }),
      }))
      callback(links.length > 0 ? links : undefined)
    },
  }
}
