# Runner hook protocol: tool-neutral authoritative session events

**Status:** Stable · **Related:** ADR 0011, `cli/gmux/internal/ptyserver`

The contract an agent implements to report its session state to the gmux runner
authoritatively. Tool-neutral: the runner makes no per-adapter assumptions in
`handleHookEvent`. pi's extension (`agentext/pi-ext.mjs`) is the reference; the
protocol is not pi-specific.

Per ADR 0011, live state is runner-owned. An agent reports its own facts (held
file, turn phase) rather than the daemon inferring them from fs scans/scrollback
— and a hook even catches a cache-served `/resume` that reads no file. The
runner only **relays** these facts; the one bit of state it keeps is a snapshot
replayed to `/events` (so a restarted daemon re-learns attribution), never used
to guess.

## Transport

- Runner exports `GMUX_SESSION_SOCK` (its Unix socket) to the agent env.
- Agent POSTs JSON to `POST /hook/event`, **fire-and-forget**: a failed POST
  must never surface into the agent; the next event re-establishes truth.
- A control-capable agent long-polls `POST /hook/control/next` and ACKs commands
  to `POST /hook/control/result`. The runner exposes user actions such as
  `PUT /name`; it never injects agent commands through PTY input.
- Socket is owner-only (0o700).

## Event schema

One JSON object per event, discriminated by `op`. Unknown ops/values are ignored
(forward-compatible); zero-value fields are no-ops.

```jsonc
// op "session" — authoritative bind. Sent on startup and on every rebind
// (switch/new/resume/fork).
{
  "op":     "session",
  "path":   "/abs/path/to/conversation-file",  // required
  "id":     "session-id",                       // optional; slugified for the URL if no slug
  "slug":   "human-title",                      // optional; explicit URL-safe slug, preferred over id
  "name":   "human title",                      // optional; sets the adapter title
  "cwd":    "/project/dir",                      // optional; accepted, not yet applied
  "reason": "startup|new|resume|fork|activity"  // optional; informational
}

// op "turn" — agent loop boundary.
{ "op": "turn", "phase": "start" }                            // → working
{ "op": "turn", "phase": "end", "outcome": "completed",       // see vocabulary
  "title": "human title" }                                    // optional

// op "title" — canonical display metadata changed outside a turn.
{ "op": "title", "path": "/abs/path/to/session.jsonl", "title": "human title" }
```

### Field reference

| Field     | Op       | Meaning |
|-----------|----------|---------|
| `path`    | session, title | Absolute conversation path; title events apply only while it matches the runner's active binding. |
| `id`      | session  | Session identity; slugified into the URL when no `slug`. |
| `slug`    | session  | Explicit URL-safe slug; preferred over `id` (e.g. codex's UUID slugifies badly). |
| `name`    | session  | Display title at bind time. |
| `cwd`     | session  | Project dir. Accepted for forward-compat but not applied — the runner knows the launch cwd. |
| `reason`  | session  | Why the bind happened; informational. |
| `phase`   | turn     | `"start"` or `"end"`. |
| `outcome` | turn end | Normalized terminal state — see below. |
| `title`   | turn end, title | Canonical display title. |

### Outcome vocabulary

Stable and agent-agnostic; each hook normalizes its native state into one. The
outcome→sidebar mapping is gmux policy in the runner (`applyTurnEnd`), not the
agent's concern.

| Outcome     | Meaning                          | Sidebar              |
|-------------|----------------------------------|----------------------|
| `completed` | Agent finished its own turn.     | idle + **unread**    |
| `aborted`   | User interrupted (Esc).          | idle                 |
| `error`     | Agent gave up.                   | idle + **error**     |

## Reverse control (optional)

Pi's extension starts no background resource in its factory. On each
`session_start` it creates a fresh extension instance and long-polls:

```jsonc
// POST /hook/control/next
{ "extension_instance": "process-and-bind-unique",
  "expected_session_file": "/abs/path/to/conversation-file" }

// response: one command
{ "id": "rename-1", "op": "set_session_name", "name": "new title",
  "extension_instance": "process-and-bind-unique",
  "expected_session_file": "/abs/path/to/conversation-file" }

// POST /hook/control/result
{ "id": "rename-1", "ok": true, "name": "canonical pi title",
  "extension_instance": "process-and-bind-unique",
  "expected_session_file": "/abs/path/to/conversation-file" }
```

`session_shutdown` aborts the poll. The extension verifies both identities
against its active `sessionManager` immediately before calling
`pi.setSessionName()`, then returns `pi.getSessionName()`. The runner permits
one pending control command, rejects stale/mismatched ACKs, and bounds both
poll and result waits. `PUT /name` succeeds only after that ACK, then applies
the canonical title to runner state. Control transport errors are swallowed by
the extension and must never throw into the agent.

## The runner does NOT, for hooked sessions

Parse the conversation file, infer status from PTY/scrollback, apply per-adapter
heuristics in `handleHookEvent`, or use the `session_file` snapshot for anything
but `/events` replay.

## Implementing for a new agent

1. **Load the hook** via the seam matching how the agent loads extensions
   (below). Both are ephemeral, scoped to the launch, and no-op without
   `GMUX_SESSION_SOCK`.
2. Report a `session` event on every bind.
3. Report `turn` start/end, normalizing to the outcome vocabulary.

### Injection seams

- **`SessionExtender`** (pi): the runner materializes the embedded pi extension
  and splices `pi -e <path>` into the argv.
- **`SessionHookCommand`** (codex): the runner injects a `gmux __codex-hook`
  command hook via the agent's config-override flags (`-c hooks.<Event>=...`),
  with the gmux binary itself as the hook program. It also carries the per-hook
  `trusted_hash` codex computes so only gmux's own hooks are trusted (never the
  global `--dangerously-bypass-hook-trust`). Version-gated; older codex falls
  back to daemon metadata attribution, and a hash mismatch degrades to the same
  fallback rather than broadening trust.
- **`SessionHookCommand`** (claude): Claude Code takes hooks through settings,
  so the runner splices `--settings <inline-json>` (a `gmux __claude-hook`
  command hook). That layer merges with the user's settings and hook arrays
  concatenate, so gmux's hooks add to rather than clobber the user's.
