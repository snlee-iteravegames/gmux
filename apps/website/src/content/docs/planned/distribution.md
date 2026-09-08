---
title: Distribution
description: How gmux is shipped — binaries, packaging, and deployment modes.
---

## Artifacts

### Native binaries

- **`gmuxd`** — machine daemon (discovery, proxy, embedded web UI)
- **`gmux`** — session runner (PTY, adapters, Unix socket server)

Both ship as platform-specific binaries with checksums. The web UI is compiled into `gmuxd` via `go:embed` — no separate web server needed.

### Distribution channels

- **Homebrew (macOS):** `brew install gmuxapp/tap/gmux`; update with `brew upgrade gmuxapp/tap/gmux`.
- **Install script (Linux):** `curl -sSfL https://gmux.app/install.sh | sh`. The script selects the current release for the host OS and architecture and verifies its checksum.
- **Direct download:** archives and checksums for each release are available from [GitHub Releases](https://github.com/gmuxapp/gmux/releases).

Releases are built with GoReleaser. The Homebrew package and install script place `gmux` and `gmuxd` together so their versions stay compatible.

### Deployment modes

**Local (default):** One command starts gmuxd + gmux on your machine. The web UI is served by gmuxd at `localhost:8790`. This is how most people use gmux.

**Remote via Tailscale:** gmuxd optionally joins your tailnet for HTTPS access from other devices. See [Remote Access](/remote-access).

## Open items

- Provenance/signing approach for binary downloads
- AUR / Nix packaging
