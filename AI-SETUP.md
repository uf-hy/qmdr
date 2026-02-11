# QMDR - AI Setup Guide

> **For AI coding agents.** Humans: just send this file to your AI.

QMDR is a fork of [tobi/qmd](https://github.com/tobi/qmd) with **remote LLM provider support** — cloud APIs replace local GGUF models for embedding, query expansion, and re-ranking.

## Install

### Option A: Source mode via Bun (recommended)

```bash
bun install -g github:ANiLinkco/qmdr   # install from GitHub
qmd --help                              # verify
```

Bun runs TypeScript natively — no compilation needed. Code changes take effect immediately.

Requires: **Bun >= 1.0**, macOS needs `brew install sqlite`.

### Option B: Pre-built binary (from GitHub Releases)

Download the binary for your platform from [Releases](https://github.com/ANiLinkco/qmdr/releases):

```bash
# macOS arm64
curl -L https://github.com/ANiLinkco/qmdr/releases/latest/download/qmd-darwin-arm64 -o /usr/local/bin/qmd
chmod +x /usr/local/bin/qmd

# Linux x64
curl -L https://github.com/ANiLinkco/qmdr/releases/latest/download/qmd-linux-x64 -o /usr/local/bin/qmd
chmod +x /usr/local/bin/qmd
```

Pre-built binaries don't require Bun, but won't auto-update. Requires `sqlite-vec` native extension to be discoverable (see Troubleshooting).

### Option C: Source mode from local clone

```bash
git clone https://github.com/ANiLinkco/qmdr.git
cd qmdr && bun install
# Use directly (shebang handles bun invocation):
./src/qmd.ts --help
# Or link globally:
bun link
```

**For OpenClaw:** set `memory.qmd.command` to the absolute path of `src/qmd.ts` (NOT `"bun /path/to/qmd.ts"` — bun misparses the subcommand).

## Configure API Keys

Pick one (all have free tiers):

```bash
# Option A: SiliconFlow only (simplest)
export QMD_SILICONFLOW_API_KEY=sk-your-key

# Option B: SiliconFlow + Gemini (recommended — better reranking)
export QMD_SILICONFLOW_API_KEY=sk-your-key
export QMD_GEMINI_API_KEY=your-gemini-key

# Option C: Any OpenAI-compatible API (OpenAI, Azure, Volcengine, relay proxies)
export QMD_OPENAI_API_KEY=your-key
export QMD_OPENAI_BASE_URL=https://api.openai.com/v1
```

Auto-detection: SiliconFlow handles embedding + query expansion; Gemini handles reranking if available; otherwise SiliconFlow does all three. OpenAI-compatible works as a standalone alternative.

Override auto-detection per-task:
```bash
export QMD_EMBED_PROVIDER=siliconflow          # or openai
export QMD_QUERY_EXPANSION_PROVIDER=siliconflow # or gemini, openai
export QMD_RERANK_PROVIDER=gemini               # or siliconflow, openai
```

## Verify Setup

```bash
qmd doctor          # check providers, models, connectivity, speed
qmd doctor --bench  # + quality evaluation of query expansion
```

**Always run `qmd doctor` after configuration changes.** Fix any errors before proceeding.

## Basic Usage

```bash
# 1. Index documents
qmd collection add ~/notes --name my-notes
qmd context add qmd://my-notes "Personal notes and journal entries"
qmd embed

# 2. Search
qmd search "keyword search"       # BM25 full-text
qmd vsearch "semantic meaning"    # vector similarity
qmd query "best quality search"   # hybrid: expansion + multi-signal + reranking

# 3. Keep index updated
qmd update          # incremental re-index
qmd embed -f        # full re-embed (required after changing embedding model)
```

## OpenClaw Integration

**`memory_search` is an internal OpenClaw tool — NOT a shell command.** Do not try to hijack it via PATH, wrapper scripts, or AGENTS.md overrides. The **only** way to use QMDR as the backend is through `openclaw.json` configuration.

### Step 1: Install QMDR and configure API keys (see above)

### Step 2: Index workspace and verify

```bash
# Index memory files
qmd collection add ~/.openclaw/workspace --name memory --mask "*.md"
qmd context add qmd://memory "Personal memory files, daily notes, long-term memory"
qmd embed

# Verify everything works BEFORE configuring OpenClaw
qmd doctor
qmd query "test query" -c memory
```

**Do not proceed until `qmd doctor` shows no errors and `qmd query` returns results.**

### Step 3: Configure openclaw.json

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

**`command` field:**
- `"qmd"` — if installed via `bun install -g` (qmd is in PATH)
- `"/absolute/path/to/qmdr/src/qmd.ts"` — if running from local clone (source mode)
- ⚠️ Do NOT use `"bun /path/to/qmd.ts"` — bun misparses subcommands as script names

| Field | Meaning |
|-------|---------|
| `backend: "qmd"` | Use QMDR instead of built-in SQLite indexer |
| `command` | Path to `qmd` binary (must be in OpenClaw process's PATH) |
| `includeDefaultMemory` | Auto-index `MEMORY.md` + `memory/**/*.md` from workspace |
| `sessions.enabled` | Auto-export & index conversation transcripts into QMDR |
| `update.interval` | How often OpenClaw runs `qmd update` + `qmd embed` (keeps index fresh) |
| `limits.maxResults` | Max snippets returned per `memory_search` call |
| `limits.timeoutMs` | Query timeout — if exceeded, falls back to built-in search |

### Step 4: Restart and verify

```bash
openclaw gateway restart

# Then ask your bot about something from past conversations
# Or check logs for "backend: qmd" in memory_search results
```

### Common Mistakes

| Mistake | Why it fails | Fix |
|---------|-------------|-----|
| Putting a wrapper script in PATH | `memory_search` is internal, never calls shell | Use `openclaw.json` config |
| Writing rules in AGENTS.md | AGENTS.md is prompt text, not config | Use `openclaw.json` config |
| API keys only in `.bashrc` | OpenClaw process doesn't source shell rc files | Add to systemd `Environment=` or launchd `EnvironmentVariables` |
| `qmd` not in OpenClaw's PATH | Binary found in shell but not in service | Verify: `sudo -u <user> which qmd` |
| Skipping `qmd doctor` | Broken provider config → silent failures | Always run `qmd doctor` first |

### Fallback behavior

If QMDR crashes, binary is missing, or query times out, OpenClaw **automatically falls back** to the built-in SQLite memory search. Your bot keeps working — just without hybrid search quality.

### Official OpenClaw docs

- Memory: https://docs.openclaw.ai/concepts/memory
- CLI memory: https://docs.openclaw.ai/cli/memory
- Configuration: https://docs.openclaw.ai/gateway/configuration

## MCP Server Integration

For Claude Desktop / Claude Code, add to MCP config:

```json
{
  "mcpServers": {
    "qmd": {
      "command": "qmd",
      "args": ["mcp"],
      "env": {
        "QMD_SILICONFLOW_API_KEY": "sk-your-key"
      }
    }
  }
}
```

## Troubleshooting

| Problem | Fix |
|---------|-----|
| `qmd: command not found` | `bun link`, ensure `~/.bun/bin` in PATH |
| sqlite-vec load error | macOS: `brew install sqlite`; or `QMD_SQLITE_VEC_PATH=/path/to/vec0.dylib` |
| sqlite-vec `/$bunfs/root/` error | You're using a compiled binary with broken paths. Switch to source mode (Option A/C) or rebuild |
| Dimension mismatch | `qmd embed -f` to rebuild with current model |
| Slow queries | `qmd doctor` — switch to non-thinking models for reranking |
| `Script not found "query"` | Don't use `"bun /path/to/qmd.ts"` as command; use direct path with shebang |

## Environment Variables Reference

| Variable | Default | Purpose |
|----------|---------|---------|
| **API Keys** | | |
| `QMD_SILICONFLOW_API_KEY` | — | SiliconFlow |
| `QMD_GEMINI_API_KEY` | — | Google Gemini |
| `QMD_OPENAI_API_KEY` | — | OpenAI-compatible |
| **Provider routing** | | |
| `QMD_EMBED_PROVIDER` | auto | `siliconflow` / `openai` |
| `QMD_QUERY_EXPANSION_PROVIDER` | auto | `siliconflow` / `gemini` / `openai` |
| `QMD_RERANK_PROVIDER` | auto | `siliconflow` / `gemini` / `openai` |
| `QMD_RERANK_MODE` | `llm` | `llm` (chat model reranking) / `rerank` (dedicated rerank model API) |
| **Custom endpoints** | | |
| `QMD_GEMINI_BASE_URL` | Google default | Custom Gemini endpoint |
| `QMD_OPENAI_BASE_URL` | `api.openai.com/v1` | Custom OpenAI endpoint |
| **Model overrides** | | |
| `QMD_SILICONFLOW_EMBED_MODEL` | `Qwen/Qwen3-Embedding-8B` | Embedding model |
| `QMD_SILICONFLOW_QUERY_EXPANSION_MODEL` | `zai-org/GLM-4.5-Air` | Query expansion |
| `QMD_SILICONFLOW_RERANK_MODEL` | `BAAI/bge-reranker-v2-m3` | Rerank model (when `QMD_RERANK_MODE=rerank`) |
| `QMD_LLM_RERANK_MODEL` | `zai-org/GLM-4.5-Air` | LLM rerank model (when `QMD_RERANK_MODE=llm`) |
| `QMD_GEMINI_MODEL` | `gemini-2.5-flash` | Gemini model |
| `QMD_OPENAI_MODEL` | `gpt-4o-mini` | OpenAI chat model |
| `QMD_OPENAI_EMBED_MODEL` | `text-embedding-3-small` | OpenAI embed model |
| **Tuning** | | |
| `QMD_CHUNK_SIZE_TOKENS` | `200` | Tokens per chunk |
| `QMD_CHUNK_OVERLAP_TOKENS` | `40` | Overlap between chunks |
| `QMD_EMBED_BATCH_SIZE` | `32` | Embedding batch size |
| `QMD_RERANK_DOC_LIMIT` | `40` | Max docs for reranking |
| `QMD_RERANK_CHUNKS_PER_DOC` | `3` | Chunks per doc for reranking |
| **Paths** | | |
| `QMD_SQLITE_VEC_PATH` | auto | sqlite-vec .dylib path |
| `QMD_LAUNCHD_PLIST` | auto | launchd plist path (doctor) |

**If you change the embedding model, run `qmd embed -f` to rebuild the vector index.**

## Links

- Original project: https://github.com/tobi/qmd
- SiliconFlow: https://siliconflow.cn (free tier)
- Gemini: https://ai.google.dev (free tier)
