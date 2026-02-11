# QMDR - AI Setup Guide

QMDR — hybrid markdown search (BM25 + vector + LLM reranking). Fork of [tobi/qmd](https://github.com/tobi/qmd), cloud APIs replace local GGUF models.

## 1. Install

Bun ≤1.3.6 required — 1.3.7+ segfault with sqlite-vec (unfixed as of 1.3.9).

**Path A — Bun (recommended):**
```bash
curl -fsSL https://bun.sh/install | bash -s "bun-v1.3.6"
# China: prepend BUN_INSTALL_MIRROR=https://npmmirror.com/mirrors/bun
bun install -g github:uf-hy/qmdr
```

**Path B — Binary (no Bun needed):**

Available: macOS arm64, Linux x64, Linux arm64. Windows and macOS Intel → use Path A.

```bash
OS=$(uname -s | tr A-Z a-z); ARCH=$(uname -m); [ "$ARCH" = "x86_64" ] && ARCH="x64"
DIR=/usr/local/bin; [ ! -w "$DIR" ] && DIR="$HOME/.local/bin" && mkdir -p "$DIR"
curl -L "https://github.com/uf-hy/qmdr/releases/latest/download/qmd-${OS}-${ARCH}" -o "$DIR/qmd" && chmod +x "$DIR/qmd"
```
Binary: sqlite-vec must be loadable. macOS: `brew install sqlite`. Linux: `apt install libsqlite3-dev` (or equivalent). Or set `QMD_SQLITE_VEC_PATH`.

Verify: `qmd --help`. If not found, ensure install dir is in PATH.

## 2. Configure

Config file: `~/.config/qmd/.env` (auto-loaded on startup). Collect all keys, write once.

```bash
mkdir -p ~/.config/qmd
```

Region: China → default endpoint works. International → add `QMD_SILICONFLOW_BASE_URL=https://api.siliconflow.com/v1`.

```env
# Required: SiliconFlow (embedding + query expansion). Register at cloud.siliconflow.cn (.com intl)
QMD_SILICONFLOW_API_KEY=sk-xxx

# Recommended: Gemini reranking. Get key at ai.google.dev. China without proxy: skip, use fallback below
QMD_GEMINI_API_KEY=xxx
QMD_RERANK_PROVIDER=gemini

# Alternative: SiliconFlow reranking (no extra key)
# QMD_RERANK_PROVIDER=siliconflow
# QMD_RERANK_MODE=llm

# Optional: custom OpenAI-compatible endpoint
# QMD_OPENAI_API_KEY=xxx
# QMD_OPENAI_BASE_URL=https://custom-endpoint.com/v1
# QMD_EMBED_PROVIDER=openai
```

Provider auto-routing: siliconflow → gemini → openai (first with configured key).
QMDR requires cloud APIs — there are no local/fallback models. Unconfigured providers will show ❌ in `qmd doctor`.

## 3. Verify

```bash
qmd doctor          # check providers
qmd doctor --bench  # optional: query quality test
```

## 4. Client Integration

### OpenClaw

Native memory backend, no MCP.

**Index workspace** (OpenClaw workspace: directory containing `openclaw.json`, typically `~/.openclaw/workspace`):
```bash
qmd collection add <WORKSPACE_PATH> --name memory --mask "*.md"  # idempotent
qmd context add qmd://memory "Personal memory files"
qmd embed
qmd query "test" -c memory  # empty result = no .md files in path
```

**Merge into `openclaw.json`** (typically `~/.openclaw/openclaw.json` — read existing first, merge `memory` block only):
```json
{
  "memory": {
    "backend": "qmd",
    "qmd": {
      "command": "qmd",
      "includeDefaultMemory": true,
      "sessions": { "enabled": true },
      "update": { "interval": "5m", "debounceMs": 15000 },
      "limits": { "maxResults": 6, "timeoutMs": 60000 }
    }
  }
}
```

`command`: `"qmd"` (global) or absolute path to `src/qmd.ts` (source mode — needs `#!/usr/bin/env bun` shebang + chmod +x).
Never use `"bun /path/to/qmd.ts"` — bun misparses subcommands.

Env keys: `~/.config/qmd/.env` auto-loaded (recommended). Or add to launchd/systemd. Process env > .env.

Restart: `openclaw gateway restart`. Verify `memory_search` returns `"provider": "qmd"`.
If QMDR fails or times out, OpenClaw automatically falls back to built-in SQLite search.

### Claude Code / OpenCode

Install skill:
```bash
# Claude Code
mkdir -p ~/.claude/skills/qmdr
curl -sL https://raw.githubusercontent.com/uf-hy/qmdr/main/skills/qmdr/SKILL.md -o ~/.claude/skills/qmdr/SKILL.md
# OpenCode
mkdir -p ~/.config/opencode/skills/qmdr
curl -sL https://raw.githubusercontent.com/uf-hy/qmdr/main/skills/qmdr/SKILL.md -o ~/.config/opencode/skills/qmdr/SKILL.md
```

Usage: `qmd query "natural language"` (hybrid) | `qmd search "keywords"` (BM25) | `qmd get "#docid"` (full doc).
Always use natural language for `query`, not keyword concatenation.

Index your project before first use:
```bash
qmd collection add . --name project --mask "*.md"
qmd embed
```

## Environment Variables

Essential (used during setup):

Variable	Default	Note
QMD_SILICONFLOW_API_KEY	—	Required
QMD_GEMINI_API_KEY	—	Recommended (reranking)
QMD_OPENAI_API_KEY	—	Optional (custom endpoint)
QMD_EMBED_PROVIDER	auto	siliconflow / openai
QMD_QUERY_EXPANSION_PROVIDER	auto	siliconflow / gemini / openai
QMD_RERANK_PROVIDER	auto	siliconflow / gemini / openai
QMD_RERANK_MODE	llm	llm / rerank (dedicated API)
QMD_SILICONFLOW_BASE_URL	https://api.siliconflow.cn/v1	International: .com
QMD_GEMINI_BASE_URL	Google default	Custom endpoint / proxy (China users)

Model/tuning overrides (change only if needed):

Variable	Default
QMD_SILICONFLOW_EMBED_MODEL	Qwen/Qwen3-Embedding-8B
QMD_SILICONFLOW_QUERY_EXPANSION_MODEL	zai-org/GLM-4.5-Air
QMD_GEMINI_MODEL	gemini-2.5-flash (thinkingBudget=0)
QMD_LLM_RERANK_MODEL	zai-org/GLM-4.5-Air
QMD_SILICONFLOW_RERANK_MODEL	BAAI/bge-reranker-v2-m3
QMD_CHUNK_SIZE_TOKENS	200
QMD_CHUNK_OVERLAP_TOKENS	40
QMD_SQLITE_VEC_PATH	auto

Changing embedding model → `qmd embed -f` to rebuild index.

## Troubleshooting

Problem	Fix
qmd: command not found	Ensure install dir in PATH
sqlite-vec load error	macOS: brew install sqlite; or set QMD_SQLITE_VEC_PATH
/$bunfs/root/ error	Use bun install -g (source), not compiled binary
Segfault on Linux	Bun ≥1.3.7 — downgrade to 1.3.6
Dimension mismatch	qmd embed -f
Slow queries (>5s)	qmd doctor — use non-thinking models
Script not found "query"	Use direct path with shebang, not "bun /path/to/qmd.ts"
