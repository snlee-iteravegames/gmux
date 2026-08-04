---
title: Directory probes
description: Git, pull request, and script metadata on workspace folders.
---

Probes add project-level context to folder headings. They run in `gmuxd`, separately from adapters, which report session-level activity.

## Built-in probes

For each local configured project path or active local session workspace, gmux reports:

- current Git branch and dirty file count;
- the current GitHub pull request number, state, and URL when an authenticated `gh` CLI is available.

Probe failures are isolated: a missing Git repository, unavailable `gh`, authentication failure, or timeout simply omits that result. Each connected peer runs probes against its own filesystem and publishes the results to the hub; the hub never executes remote paths locally. Older peers that do not publish probes remain compatible and simply show no metadata.

## Script probes

Place executable `.sh` files in `~/.config/gmux/probes/` (or `$XDG_CONFIG_HOME/gmux/probes/`). gmux passes the canonical workspace as both the first argument and `$GMUX_WORKSPACE`.

```bash
#!/usr/bin/env bash
set -euo pipefail
printf '{"label":"CI","value":"passing","status":"success","url":"https://ci.example.test/build/42"}\n'
```

Each script must print one JSON object:

| Field | Required | Values |
|-------|----------|--------|
| `label` | yes | short display label |
| `value` | yes | short display value |
| `status` | no | `neutral`, `info`, `success`, `warning`, or `error` |
| `url` | no | HTTP(S) URL opened from the folder heading |

For safety and responsiveness, gmux only runs executable regular `.sh` files, rejects symlinks and unknown JSON fields, limits script count/output size, and enforces a short timeout. Invalid or failed scripts are omitted without affecting other probes.

## Refresh and display

Results are cached briefly and refreshed in the background. Changed results are pushed to the browser through the normal world snapshot update. Folder headings show probe metadata alongside an aggregate urgency dot and the visible session count.
