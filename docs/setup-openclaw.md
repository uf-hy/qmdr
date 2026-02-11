# QMDR — OpenClaw Integration

> This document is for AI agents configuring QMDR as OpenClaw's memory backend.

## How it works

OpenClaw has a native QMDR integration — no MCP, no middleware. When configured, OpenClaw spawns `qmd` directly as its memory search engine. Every `memory_search` call goes through QMDR's full hybrid pipeline (BM25 + vector + query expansion + LLM reranking).

**`memory_search` is an internal OpenClaw tool — NOT a shell command.** Do not hijack it via PATH, wrapper scripts, or AGENTS.md overrides.

## Step 1: Install QMDR and configure API keys

Follow [AI-SETUP.md](../AI-SETUP.md) Phase 2-5.

## Step 2: Index workspace and verify

```bash
# Index memory files
qmd collection add ~/.openclaw/workspace --name memory --mask "*.md"
qmd context add qmd://memory "Personal memory files, daily notes, long-term memory"
qmd embed

# Verify before proceeding
qmd doctor
qmd query "test query" -c memory
```

**Do not proceed until `qmd doctor` shows no errors and `qmd query` returns results.**

## Step 3: Configure openclaw.json

Edit `~/.openclaw/openclaw.json` — add/merge the `memory` block:

```json
{
  "memory": {
    "backend": "qmd",
    "qmd": {
      "command": "qmd",
      "includeDefaultMemory": true,
      "sessions": {
        "enabled": true
      },
      "update": {
        "interval": "5m",
        "debounceMs": 15000
      },
      "limits": {
        "maxResults": 6,
        "timeoutMs": 60000
      }
    }
  }
}
```

### `command` field

| Scenario | Value |
|----------|-------|
| Installed via `bun install -g` | `"qmd"` |
| Local clone (source mode) | `"/absolute/path/to/qmdr/src/qmd.ts"` |

⚠️ Do NOT use `"bun /path/to/qmd.ts"` — bun misparses subcommands as script names.

### Config fields explained

| Field | Meaning |
|-------|---------|
| `backend: "qmd"` | Use QMDR instead of built-in SQLite indexer |
| `command` | Path to `qmd` binary (must be in OpenClaw process's PATH) |
| `includeDefaultMemory` | Auto-index `MEMORY.md` + `memory/**/*.md` from workspace |
| `sessions.enabled` | Auto-export & index conversation transcripts |
| `update.interval` | How often OpenClaw runs `qmd update` + `qmd embed` |
| `limits.maxResults` | Max snippets returned per `memory_search` call |
| `limits.timeoutMs` | Query timeout — exceeding falls back to built-in search |

## Step 4: Environment variables for the OpenClaw process

API keys must be available to the OpenClaw process, not just your shell.

**Option A: Use `~/.config/qmd/.env` (recommended — works for all install types)**

QMDR auto-loads this file on startup. If you already configured it in Phase 3-5, you're done — OpenClaw will inherit these settings automatically.

**Option B: macOS (launchd) — set in the service plist:**
Add to `~/Library/LaunchAgents/ai.openclaw.gateway.plist` under `EnvironmentVariables`:
```xml
<key>QMD_SILICONFLOW_API_KEY</key>
<string>sk-your-key</string>
<key>QMD_GEMINI_API_KEY</key>
<string>your-gemini-key</string>
```
Then reload: `launchctl unload ~/Library/LaunchAgents/ai.openclaw.gateway.plist && launchctl load ~/Library/LaunchAgents/ai.openclaw.gateway.plist`

**Option C: Linux (systemd) — set in the service unit:**
Add to the service unit under `[Service]`:
```ini
Environment=QMD_SILICONFLOW_API_KEY=sk-your-key
Environment=QMD_GEMINI_API_KEY=your-gemini-key
```
Then: `systemctl --user daemon-reload && systemctl --user restart openclaw`

**Priority:** System/process env vars > `~/.config/qmd/.env` (env vars override .env if both are set).

## Step 5: Restart and verify

Before restarting, confirm:
1. `qmd doctor` passes with no errors ✅
2. `qmd query "test"` returns results ✅
3. API keys are in launchd/systemd env (Step 4) ✅

```bash
openclaw gateway restart

# Or if using OpenClaw CLI:
openclaw gateway stop && openclaw gateway start
```

After restart, verify QMDR is active:
- Ask your bot about something from past conversations
- Check that `memory_search` results show `"provider": "qmd"` (not `"sqlite"`)
- If results seem to fall back to basic search, check `qmd doctor` inside the OpenClaw process environment

## Step 6: Add usage tips to TOOLS.md

Add to `TOOLS.md` in the workspace:

```markdown
## Memory Search (QMDR)

- **Always use natural language** for memory_search queries — not keyword concatenation
- ✅ Good: "what did we discuss about the server migration last week"
- ❌ Bad: "server migration discussion last week"
- The hybrid pipeline (query expansion + vector + rerank) is optimized for natural language
- `memory_search` is an internal OpenClaw tool, never a shell command
```

## Common Mistakes

| Mistake | Why it fails | Fix |
|---------|-------------|-----|
| Wrapper script in PATH | `memory_search` is internal, never calls shell | Use `openclaw.json` config |
| Rules in AGENTS.md | AGENTS.md is prompt text, not config | Use `openclaw.json` config |
| Keys only in `.bashrc` | OpenClaw doesn't source shell rc files | Add to launchd/systemd env |
| `qmd` not in OpenClaw's PATH | Binary found in shell but not in service | Set absolute path in `command` |
| Skipping `qmd doctor` | Broken config → silent fallback | Always run doctor first |

## Fallback behavior

If QMDR crashes, binary is missing, or query times out, OpenClaw **automatically falls back** to built-in SQLite memory search. Your bot keeps working — just without hybrid search quality.

## Official OpenClaw docs

- Memory backend: https://docs.openclaw.ai/concepts/memory
- Configuration: https://docs.openclaw.ai/gateway/configuration
