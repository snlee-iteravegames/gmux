import { describe, expect, test } from 'vitest'
import type { VNode } from 'preact'
import {
  previewErrorMessage,
  previewRequestUrl,
  renderMarkdownInline,
} from './preview-panel'

describe('preview request helpers', () => {
  test('encodes both the session id and file path', () => {
    expect(previewRequestUrl('session/with space', '../docs/a file.md')).toBe(
      '/v1/sessions/session%2Fwith%20space/preview?path=..%2Fdocs%2Fa%20file.md',
    )
  })

  test('reads message and error JSON shapes before falling back', async () => {
    expect(await previewErrorMessage(new Response(
      JSON.stringify({ message: 'outside workspace' }),
      { status: 403, statusText: 'Forbidden' },
    ))).toBe('outside workspace')
    expect(await previewErrorMessage(new Response(
      JSON.stringify({ error: { message: 'file missing' } }),
      { status: 404, statusText: 'Not Found' },
    ))).toBe('file missing')
    expect(await previewErrorMessage(new Response(
      'not-json',
      { status: 502, statusText: 'Bad Gateway' },
    ))).toBe('Bad Gateway')
  })
})

describe('safe Markdown links', () => {
  test('creates anchors only for HTTP(S)', () => {
    const nodes = renderMarkdownInline(
      '[safe](https://example.com) [bad](javascript:alert(1)) [local](./README.md)',
    )
    const anchors = nodes.filter(node => typeof node === 'object') as VNode[]

    expect(anchors).toHaveLength(1)
    expect(anchors[0].type).toBe('a')
    expect(anchors[0].props).toMatchObject({
      href: 'https://example.com',
      target: '_blank',
      rel: 'noopener noreferrer',
    })
    expect(nodes.join('')).toContain('[bad](javascript:alert(1))')
    expect(nodes.join('')).toContain('[local](./README.md)')
  })

  test('keeps raw HTML as text rather than an HTML vnode', () => {
    const nodes = renderMarkdownInline('<img src=x onerror=alert(1)>')
    expect(nodes).toEqual(['<img src=x onerror=alert(1)>'])
  })
})
