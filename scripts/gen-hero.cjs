#!/usr/bin/env node
/**
 * Generate desktop + mobile hero screenshots for the landing page.
 *
 * Usage:
 *   node scripts/gen-hero.cjs           # mock server must be running on :5199
 *   node scripts/gen-hero.cjs --serve   # auto-start vite dev server
 *
 * Output:
 *   apps/website/src/assets/hero-desktop.png
 *   apps/website/src/assets/hero-mobile.png
 *   apps/website/public/og.png
 */

const { chromium } = require('playwright')
const { spawn } = require('child_process')
const fs = require('fs')
const path = require('path')

const ROOT = path.resolve(__dirname, '..')
const PORT = 5199
const BASE = `http://localhost:${PORT}`

// Desktop: ?host=laptop hides the "laptop" peer pill (you're ON the laptop)
const DESKTOP_URL = `${BASE}/?mock&host=laptop`
// Mobile: shows all peer pills (you're viewing from a different device)
const MOBILE_URL = `${BASE}/?mock`

async function waitForServer(url, timeoutMs = 15000) {
  const start = Date.now()
  while (Date.now() - start < timeoutMs) {
    try {
      const r = await fetch(url)
      if (r.ok) return
    } catch {}
    await new Promise(r => setTimeout(r, 200))
  }
  throw new Error(`Server not ready at ${url} after ${timeoutMs}ms`)
}

const FREEZE_CSS = `
  *, *::before, *::after {
    transition: none !important;
    animation-duration: 0s !important;
    animation-delay: 0s !important;
    animation-iteration-count: 1 !important;
    caret-color: transparent !important;
  }

  .session-dot-indicator.working,
  .terminal-loading-dot,
  .session-dot.working,
  .main-header-status .session-dot {
    opacity: 1 !important;
    animation: none !important;
    transform: none !important;
    filter: saturate(1.15) brightness(1.12) !important;
  }
`

async function preparePage(page, url) {
  // Headless system Chrome does not reliably composite xterm's WebGL canvas
  // into screenshots. Disable only WebGL contexts for capture pages so xterm
  // falls back to its screenshot-safe 2D renderer.
  await page.addInitScript(() => {
    const getContext = HTMLCanvasElement.prototype.getContext
    HTMLCanvasElement.prototype.getContext = function (type, ...args) {
      if (type === 'webgl' || type === 'webgl2' || type === 'experimental-webgl') return null
      return getContext.call(this, type, ...args)
    }
  })
  await page.goto(url, { timeout: 5000, waitUntil: 'load' })
  await page.waitForSelector('.session-item', { timeout: 5000 })
  // The current home route no longer auto-selects a session. Open the first
  // row so marketing captures exercise the terminal/header/mobile controls.
  if (!await page.$('.xterm-screen')) {
    const href = await page.locator('.session-item').first().getAttribute('href')
    if (href) {
      const target = new URL(href, BASE)
      target.search = new URL(url).search
      await page.goto(target.href, { timeout: 5000, waitUntil: 'load' })
    }
  }
  // Wait for mock terminal canvas to render content
  await page.waitForSelector('.xterm-screen canvas', { timeout: 5000 }).catch(() => {})
  await page.waitForTimeout(800)
  await page.addStyleTag({ content: FREEZE_CSS })
}

async function takeDesktop(browser) {
  console.log('Taking desktop screenshot...')
  const page = await browser.newPage({
    viewport: { width: 800, height: 650 },
    deviceScaleFactor: 2,
  })

  await preparePage(page, DESKTOP_URL)

  const outPath = path.join(ROOT, 'apps/website/src/assets/hero-desktop.png')
  await page.screenshot({ path: outPath })
  await page.close()

  const stat = fs.statSync(outPath)
  console.log(`  → ${path.relative(ROOT, outPath)} (${(stat.size / 1024).toFixed(0)}KB)`)
}

async function takeOG(browser) {
  console.log('Taking OpenGraph screenshot...')
  const page = await browser.newPage({
    viewport: { width: 1200, height: 630 },
    deviceScaleFactor: 1,
  })

  await preparePage(page, DESKTOP_URL)

  const outPath = path.join(ROOT, 'apps/website/public/og.png')
  await page.screenshot({ path: outPath })
  await page.close()

  const stat = fs.statSync(outPath)
  console.log(`  → ${path.relative(ROOT, outPath)} (${(stat.size / 1024).toFixed(0)}KB)`)
}

async function takeMobile(browser) {
  console.log('Taking mobile screenshot...')
  // hasTouch + isMobile trigger the pointer:coarse layout in both bundled
  // Playwright Chromium and a system Chrome fallback.
  const page = await browser.newPage({
    viewport: { width: 310, height: 560 },
    deviceScaleFactor: 2,
    isMobile: true,
    hasTouch: true,
  })

  await preparePage(page, MOBILE_URL)
  await page.waitForSelector('.mobile-bottom-bar', { timeout: 5000 })

  // Open the sidebar
  const menuBtn = await page.$('.mobile-bottom-bar button:first-child')
  if (menuBtn) {
    await menuBtn.click()
    await page.waitForTimeout(300)
  }

  // Re-freeze after sidebar layout settles.
  await page.addStyleTag({ content: FREEZE_CSS })
  await page.waitForTimeout(200)

  const outPath = path.join(ROOT, 'apps/website/src/assets/hero-mobile.png')
  await page.screenshot({ path: outPath })
  await page.close()

  const stat = fs.statSync(outPath)
  console.log(`  → ${path.relative(ROOT, outPath)} (${(stat.size / 1024).toFixed(0)}KB)`)
}

;(async () => {
  const shouldServe = process.argv.includes('--serve')
  let server = null

  try {
    if (shouldServe) {
      console.log('Starting vite dev server...')
      server = spawn('npx', ['vite', '--port', String(PORT)], {
        cwd: path.join(ROOT, 'apps/gmux-web'),
        env: { ...process.env, VITE_MOCK: '1' },
        stdio: 'pipe',
      })
    }

    await waitForServer(`${BASE}/?mock`)
    console.log('Server ready.')

    // xterm's fit.fit() reflow behaves differently on the first page load in a
    // browser vs. subsequent loads (browser-level state, not isolated by
    // contexts). Use a fresh browser per shot to guarantee first-load behavior.
    const systemChrome = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
    const launchArgs = {
      args: ['--disable-blink-features=TextAutosizing'],
      ...(fs.existsSync(systemChrome) ? { executablePath: systemChrome } : {}),
    }

    const d = await chromium.launch(launchArgs)
    await takeDesktop(d)
    await d.close()

    const m = await chromium.launch(launchArgs)
    await takeMobile(m)
    await m.close()

    const og = await chromium.launch(launchArgs)
    await takeOG(og)
    await og.close()

    console.log('\n✓ Hero and OpenGraph screenshots generated.')
  } finally {
    if (server) server.kill('SIGTERM')
  }
})()
