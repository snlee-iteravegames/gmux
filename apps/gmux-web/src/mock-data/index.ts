/**
 * Mock data: one file per session in sessions/.
 * Active with ?mock query param or VITE_MOCK=1.
 */

import type { DirectoryProbes } from '@gmux/protocol'
import type { ProjectItem, PeerInfo } from '../types'
import type { HealthData } from '../store'
import type { MockSession } from './types'

import codexRefactorAdapters from './sessions/codex-refactor-adapters'
import claudeDesignLanding from './sessions/claude-design-landing'
import piFixScrollback from './sessions/pi-fix-scrollback'
import piAutoresearch from './sessions/pi-autoresearch'
import codexMigrateConvex from './sessions/codex-migrate'
import shellOpenclawConfigure from './sessions/shell-openclaw-configure'
import shellOpenclawLogs from './sessions/shell-openclaw-logs'

/** All mock sessions. First alive session is auto-selected. */
export const MOCK_SESSIONS: MockSession[] = [
  codexRefactorAdapters,
  piFixScrollback,
  claudeDesignLanding,
  piAutoresearch,
  codexMigrateConvex,
  shellOpenclawConfigure,
  shellOpenclawLogs,
]

/** Mock peers (host roster). Exercises the Hosts-tab groups
 *  (devcontainer, manual) and every row state: online, offline (a
 *  connection error), and auth-needed (drives the amber "Add token"
 *  affordance). */
export const MOCK_PEERS: PeerInfo[] = [
  { name: 'laptop', url: 'https://laptop.tail-scale.ts.net', status: 'connected', session_count: 2, version: '1.2.0', source: 'manual' },
  { name: 'server', url: 'https://server.tail-scale.ts.net', status: 'connected', session_count: 4, version: '1.1.9', source: 'manual' },
  { name: 'devcontainer', url: 'https://devcontainer.tail-scale.ts.net', status: 'connected', session_count: 1, version: '1.2.0', local: true, source: 'devcontainer' },
  { name: 'konyvtar', url: 'https://gmux.tail95157a.ts.net', status: 'connected', session_count: 1, version: '1.2.0', source: 'manual' },
  { name: 'bespin', url: 'https://bespin.tail-scale.ts.net', status: 'disconnected', session_count: 0, last_error: 'dial tcp 100.84.12.9:443: connect: connection refused', source: 'manual' },
  { name: 'cloud-city', url: 'https://cloud-city.tail-scale.ts.net', status: 'disconnected', session_count: 0, last_error: 'authentication failed', source: 'manual' },
]

/** Mock daemon health for the local host. */
export const MOCK_HEALTH: HealthData = {
  version: '1.2.0',
  hostname: 'workstation',
  peers: MOCK_PEERS,
}

/** Folder metadata used by product screenshots and mock-mode development. */
export const MOCK_DIRECTORY_PROBES: DirectoryProbes = {
  '/home/user/dev/my-project': {
    git: { branch: 'feature/probes', dirty_count: 3 },
    pr: { number: 42, status: 'open', url: 'https://github.com/acme/my-project/pull/42' },
    scripts: [{ id: 'ci', label: 'CI', value: 'passing', status: 'success' }],
  },
}

export const MOCK_PEER_DIRECTORY_PROBES: Record<string, DirectoryProbes> = {
  laptop: {
    '/home/user/dev/my-project': {
      git: { branch: 'feature/probes', dirty_count: 3 },
      pr: { number: 42, status: 'open', url: 'https://github.com/acme/my-project/pull/42' },
      scripts: [{ id: 'ci', label: 'CI', value: 'passing', status: 'success' }],
    },
  },
  server: {
    '/home/user/dev/openclaw': {
      git: { branch: 'main', dirty_count: 0 },
      scripts: [{ id: 'deploy', label: 'Deploy', value: 'healthy', status: 'success' }],
    },
  },
}

/** Session ID → mock session (for terminal content + cursor lookup). */
export const MOCK_BY_ID: Record<string, MockSession> = Object.fromEntries(
  MOCK_SESSIONS.map(m => [m.id, m]),
)

/**
 * Mock projects, matching the session remotes/paths.
 * These feed into buildProjectFolders the same way
 * the server-side project config does.
 */
export const MOCK_PROJECTS: ProjectItem[] = [
  {
    slug: 'my-project',
    match: [
      { remote: 'github.com/acme/my-project' },
      { path: '~/dev/my-project' },
    ],
  },
  {
    slug: 'openclaw',
    match: [
      { remote: 'github.com/acme/openclaw' },
      { path: '~/dev/openclaw' },
    ],
  },
  // A resolved reference to a roster peer (server).
  { slug: 'api', peer: 'server' },
  // A reference to a roster host that is currently disconnected
  // (bespin) — surfaces as an offline/unavailable project.
  { slug: 'telemetry', peer: 'bespin' },
  // An unresolved reference: 'old-tower' is in no roster bucket, so it
  // surfaces as a host-not-found state in the sidebar and Hosts tab.
  { slug: 'legacy-app', peer: 'old-tower' },
]
