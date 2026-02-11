# QMDR — QMD Remote

> **Remote-first fork of [tobi/qmd](https://github.com/tobi/qmd)** — cloud APIs replace local GGUF models for embedding, query expansion, and re-ranking.

[简体中文](docs/README-zh.md)

---

## 🤖 For AI Agents

**Copy this line into your AI coding tool:**

| Tool | How to install |
|------|---------------|
| **OpenClaw** | See [AI-SETUP.md](AI-SETUP.md) → `memory.qmd` config |
| **Claude Code** | `claude mcp add qmd -- qmd mcp` |
| **OpenCode** | Add to MCP config (see [AI-SETUP.md](AI-SETUP.md#mcp-server-integration)) |
| **Claude Desktop** | Add to MCP config (see [AI-SETUP.md](AI-SETUP.md#mcp-server-integration)) |
| **Cursor / Windsurf** | Add to MCP config (see [AI-SETUP.md](AI-SETUP.md#mcp-server-integration)) |

**Full AI setup guide → [AI-SETUP.md](AI-SETUP.md)**

---

## What is this?

[QMD](https://github.com/tobi/qmd) is a hybrid search engine for your markdown files — BM25 + vector search + LLM reranking. Great for giving AI agents long-term memory.

**QMDR** is the remote version:
- 🌐 **Remote LLM providers** — SiliconFlow, Gemini, or any OpenAI-compatible API
- ⚡ **No local models** — no GGUF downloads, no GPU needed
- 🔧 **20+ env vars** — fully configurable models, endpoints, and tuning
- 📦 **Source mode** — Bun runs TypeScript natively, zero compilation

## Install

```bash
bun install -g github:uf-hy/qmdr
qmd doctor    # verify setup
```

Requires: [Bun](https://bun.sh) >= 1.0 · macOS needs `brew install sqlite`

## Quick Start

```bash
# 1. Set API key (SiliconFlow free tier)
export QMD_SILICONFLOW_API_KEY=sk-your-key

# 2. Index your files
qmd collection add ~/notes --name notes
qmd embed

# 3. Search
qmd query "what did I write about last week"
```

## Credits

Based on [QMD](https://github.com/tobi/qmd) by Tobias Lütke. Licensed under [MIT](LICENSE).
