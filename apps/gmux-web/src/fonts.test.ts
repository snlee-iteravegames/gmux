import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const here = fileURLToPath(new URL('.', import.meta.url))
const css = readFileSync(`${here}/fonts.css`, 'utf8')
const styles = readFileSync(`${here}/styles.css`, 'utf8')
const packageJson = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'))

/**
 * Guards the bundled Nerd Font icon fallback. These are cross-file invariants
 * that are easy to break silently:
 *  - the woff2 referenced by fonts.css must actually exist and be a real woff2
 *    (the asset has gone missing in a working copy before);
 *  - it must stay within a sane size budget — accidentally committing the full
 *    ~1.15 MB Symbols font instead of the subset would more than double the
 *    app's font payload.
 */
describe('local UI fonts and Nord palette', () => {
  it('bundles Inter for UI and JetBrains Mono for code without legacy fonts', () => {
    expect(css).toContain("@fontsource/inter/400.css")
    expect(css).toContain("@fontsource/jetbrains-mono/400.css")
    expect(styles).toContain("font-family: 'Inter'")
    expect(styles).toContain("font-family: 'JetBrains Mono'")
    expect(`${css}\n${styles}`).not.toMatch(/Source Sans 3|Instrument Sans|Fira Code/)
    expect(packageJson.dependencies).toHaveProperty('@fontsource/inter')
    expect(packageJson.dependencies).toHaveProperty('@fontsource/jetbrains-mono')
    expect(packageJson.dependencies).not.toHaveProperty('@fontsource/source-sans-3')
    expect(packageJson.dependencies).not.toHaveProperty('@fontsource/instrument-sans')
    expect(packageJson.dependencies).not.toHaveProperty('@fontsource/fira-code')
  })

  it('defines every canonical Nord color and removes custom OKLCH literals', () => {
    const nord = [
      '#2e3440', '#3b4252', '#434c5e', '#4c566a',
      '#d8dee9', '#e5e9f0', '#eceff4', '#8fbcbb',
      '#88c0d0', '#81a1c1', '#5e81ac', '#bf616a',
      '#d08770', '#ebcb8b', '#a3be8c', '#b48ead',
    ]
    for (const color of nord) expect(styles).toContain(color)
    expect(styles).not.toContain('oklch(')
  })
})

describe('bundled Nerd Font subset', () => {
  // Pull the url() the @font-face actually points at, rather than hard-coding it.
  const match = css.match(/url\(['"]?(\.\/assets\/[^'")]+\.woff2)['"]?\)/)

  it('fonts.css references a bundled woff2 asset', () => {
    expect(match, 'no woff2 url() found in fonts.css').not.toBeNull()
  })

  it('the referenced woff2 exists and is a valid woff2', () => {
    const rel = match![1]
    const bytes = readFileSync(`${here}/${rel}`)
    // woff2 files begin with the signature "wOF2".
    expect(bytes.subarray(0, 4).toString('latin1')).toBe('wOF2')
  })

  it('stays within the bundle-size budget (subset, not the full font)', () => {
    const rel = match![1]
    const sizeKb = readFileSync(`${here}/${rel}`).byteLength / 1024
    // Subset is ~490 KB; the full Symbols font is ~1.15 MB. A generous ceiling
    // catches an accidental full-font commit without being brittle to minor
    // upstream glyph changes.
    expect(sizeKb).toBeLessThan(700)
    expect(sizeKb).toBeGreaterThan(100)
  })

  it('declares a unicode-range so the font is not fetched for plain text', () => {
    // Without unicode-range the browser treats the icon font as a candidate for
    // any glyph the primary font lacks (CJK, emoji), needlessly fetching it.
    const block = css.match(/@font-face\s*{[^}]*Symbols Nerd Font Mono[^}]*}/s)?.[0] ?? ''
    expect(block).toMatch(/unicode-range:/)
  })
})
