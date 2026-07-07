# Command Center — Uninstall Guide

Installed: 2026-07-07 by Odin
Source: https://github.com/jontsai/openclaw-command-center
Version: 1.4.1

## What was installed

| Item | Location | Notes |
|------|----------|-------|
| Git clone | `/home/odin/.openclaw/workspace/command-center/` | 6.7MB, zero npm deps |
| Data dir (auto-created) | `/home/odin/.openclaw/command-center/data/` | Copied AGENTS.md, operators.json.example, privacy-settings.json.example |
| Tailscale serve | `https://asguard.tail64eec3.ts.net:3333` → `http://127.0.0.1:3333` | HTTPS proxy |

## No system-level changes

- No npm global installs
- No systemd services
- No PM2 processes
- No crontab entries
- No modifications to openclaw.json or any existing config

## To stop the server

```bash
# Find and kill the node process
pkill -f "node lib/server.js" 
# Or if you have the PID:
kill <pid>
```

## To fully uninstall

```bash
# 1. Stop the server
pkill -f "command-center/lib/server.js"

# 2. Remove Tailscale serve route
tailscale serve --https=3333 off

# 3. Remove the cloned repo
rm -rf /home/odin/.openclaw/workspace/command-center/

# 4. Remove the auto-created data directory
rm -rf /home/odin/.openclaw/command-center/

# Done — zero traces left
```
