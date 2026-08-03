import { describe, expect, test, vi } from 'vitest'
import type { ILink, Terminal } from '@xterm/xterm'
import {
  createTerminalFileLinkProvider,
  findTerminalFileLinks,
  parseTerminalFileTarget,
} from './terminal-file-link'

describe('terminal file target parsing', () => {
  test.each([
    ['README.md', { path: 'README.md' }],
    ['./docs/a.md', { path: './docs/a.md' }],
    ['../', { path: '../' }],
    ['/absolute/path', { path: '/absolute/path' }],
    ['~/path', { path: '~/path' }],
    ['src/a.ts:42', { path: 'src/a.ts', line: 42 }],
    ['src/a.ts:42:5', { path: 'src/a.ts', line: 42 }],
  ])('parses %s', (text, expected) => {
    expect(parseTerminalFileTarget(text)).toEqual(expected)
  })

  test.each([
    'https://example.com/a.ts',
    'http://example.com',
    'www.example.com/a.ts',
    'mailto:user@example.com',
    'vscode://file/src/a.ts:42',
    'user@example.com',
    'C:\\src\\a.ts',
    'not-a-file',
  ])('does not claim %s', text => {
    expect(parseTerminalFileTarget(text)).toBeNull()
  })
})

describe('terminal file matching', () => {
  test('removes surrounding and trailing punctuation while preserving ranges', () => {
    const text = 'see (README.md), then "src/a.ts:42:5" and ./docs/a.md.'
    expect(findTerminalFileLinks(text)).toEqual([
      {
        path: 'README.md',
        text: 'README.md',
        startIndex: text.indexOf('README.md'),
        endIndex: text.indexOf('README.md') + 'README.md'.length,
      },
      {
        path: 'src/a.ts',
        line: 42,
        text: 'src/a.ts:42:5',
        startIndex: text.indexOf('src/a.ts'),
        endIndex: text.indexOf('src/a.ts') + 'src/a.ts:42:5'.length,
      },
      {
        path: './docs/a.md',
        text: './docs/a.md',
        startIndex: text.indexOf('./docs/a.md'),
        endIndex: text.indexOf('./docs/a.md') + './docs/a.md'.length,
      },
    ])
  })

  test('leaves web, URI, and email links to existing handlers', () => {
    expect(findTerminalFileLinks(
      'https://example.com/a.ts www.example.com/a.ts vscode://file/src/a.ts:42 me@example.com README.md',
    ).map(match => match.path)).toEqual(['README.md'])
  })
})

describe('xterm file link provider', () => {
  test('uses 1-based xterm ranges and activates with path and line', () => {
    const text = 'open src/a.ts:42:5 now'
    const terminal = {
      buffer: {
        active: {
          getLine: (index: number) => index === 6
            ? { translateToString: () => text }
            : undefined,
        },
      },
    } as unknown as Terminal
    const activate = vi.fn()
    const provider = createTerminalFileLinkProvider(terminal, activate)
    let links: ILink[] | undefined

    provider.provideLinks(7, result => { links = result })

    expect(links).toHaveLength(1)
    expect(links?.[0].range).toEqual({
      start: { x: 6, y: 7 },
      end: { x: 18, y: 7 },
    })
    links?.[0].activate({} as MouseEvent, links[0].text)
    expect(activate).toHaveBeenCalledWith({ path: 'src/a.ts', line: 42 })
  })

  test('returns undefined when the buffer line is absent or has no files', () => {
    const terminal = {
      buffer: {
        active: {
          getLine: (index: number) => index === 0
            ? { translateToString: () => 'https://example.com' }
            : undefined,
        },
      },
    } as unknown as Terminal
    const provider = createTerminalFileLinkProvider(terminal, vi.fn())
    const results: Array<ILink[] | undefined> = []

    provider.provideLinks(1, result => results.push(result))
    provider.provideLinks(2, result => results.push(result))

    expect(results).toEqual([undefined, undefined])
  })
})
