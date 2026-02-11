# QMDR - AI Setup Guide

> **For AI coding agents.** Humans: just paste this file's URL to your AI and let it handle the rest.

QMDR is a fork of [tobi/qmd](https://github.com/tobi/qmd) — a hybrid search engine for markdown files (BM25 + vector + LLM reranking). QMDR replaces local GGUF models with cloud APIs, so there's no GPU needed and reranking quality is much higher.

---

## Phase 0: Detect Environment

Before starting, determine the following:

### 1. Which AI client is the user using?

| Client | Integration | Config file for usage tips |
|--------|------------|---------------------------|
| **OpenClaw** | Native memory backend | `TOOLS.md` in workspace |
| **Claude Code** | Skill (SKILL.md) | `CLAUDE.md` in project root |
| **OpenCode** | Skill (SKILL.md) | `AGENTS.md` in project root |
| **Other** | CLI only | N/A |

### 2. What region is the user in?

Detect via system locale, timezone, or ask directly. This affects:
- **China** → Use `https://cloud.siliconflow.cn` for registration, `https://api.siliconflow.cn/v1` as API endpoint. Bun install may need mirror.
- **International** → Use `https://cloud.siliconflow.com` for registration, `https://api.siliconflow.com/v1` as API endpoint.

### 3. Interaction style

| Client | How to present choices |
|--------|----------------------|
| **OpenClaw** | Use inline buttons (`buttons` parameter in message tool) |
| **Claude Code / OpenCode** | Numbered list — ask user to reply with number |
| **Other** | Y/N or numbered input |

---

## Phase 1: Quick Install or Step-by-Step?

Ask the user:

> **Do you want one-click install or step-by-step setup?**
>
> **One-click:** Provide your API keys and I'll handle everything — install Bun (if missing), install QMDR, configure all providers, verify with doctor.
>
> **Step-by-step:** I'll walk you through each decision.

### One-click install flow

Collect upfront:
1. SiliconFlow API key (required for embedding)
2. Gemini API key (recommended for reranking) — or skip to use SiliconFlow for everything
3. Any custom OpenAI-compatible endpoint (optional)

Then execute Phase 2 → 3 → 4 → 5 → 6 → 7 automatically, using defaults for all choices.

### Step-by-step flow

Continue to Phase 2.

---

## Phase 2: Install QMDR

### Check for Bun

```bash
bun --version 2>/dev/null || echo "NOT_INSTALLED"
```

**If Bun is installed:** skip to "Install QMDR" below.

**If Bun is NOT installed:** ask the user:

> Bun is required to run QMDR. Install it?
>
> 1. **Yes, install Bun** (recommended)
> 2. **No, download pre-built binary instead**

#### Install Bun

```bash
# International
curl -fsSL https://bun.sh/install | bash

# China (if above fails or is slow)
curl -fsSL https://bun.sh/install | BUN_INSTALL_MIRROR=https://npmmirror.com/mirrors/bun bash
```

After install, verify: `bun --version`

#### Install QMDR (two paths)

**Path A: Via Bun (recommended)**
```bash
bun install -g github:uf-hy/qmdr
qmd --help  # verify
```

**Path B: Pre-built binary (no Bun needed)**
```bash
# macOS arm64
curl -L https://github.com/uf-hy/qmdr/releases/latest/download/qmd-darwin-arm64 -o /usr/local/bin/qmd
chmod +x /usr/local/bin/qmd

# Linux x64
curl -L https://github.com/uf-hy/qmdr/releases/latest/download/qmd-linux-x64 -o /usr/local/bin/qmd
chmod +x /usr/local/bin/qmd
```

⚠️ Binary users: `sqlite-vec` native extension must be discoverable. macOS: `brew install sqlite`. Or set `QMD_SQLITE_VEC_PATH=/path/to/vec0.dylib`.

---

## Phase 3: Configure Embedding (SiliconFlow)

SiliconFlow provides the embedding model. Ask:

> **Do you have a SiliconFlow API key?**
>
> 1. **Yes** — I'll enter my key
> 2. **No** — show me how to get one
> 3. **Custom provider** — I want to use a different OpenAI-compatible endpoint

### Option 1: User has key

```bash
export QMD_SILICONFLOW_API_KEY=sk-user-provided-key
```

### Option 2: Guide to get key

**China users:**
> Register at https://cloud.siliconflow.cn (no affiliate link, the author was too lazy to set one up)
> 1. Sign up with phone number or email
> 2. Go to API Keys page → Create new key
> 3. Free tier includes embedding models

**International users:**
> Register at https://cloud.siliconflow.com (no affiliate link)
> 1. Sign up with email
> 2. Go to API Keys page → Create new key
> 3. Free tier includes embedding models

After user provides key:
```bash
export QMD_SILICONFLOW_API_KEY=sk-user-provided-key
```

**International users — additional API endpoint config:**
```bash
export QMD_SILICONFLOW_BASE_URL=https://api.siliconflow.com/v1
```
(China users don't need this — the default `https://api.siliconflow.cn/v1` works)

### Option 3: Custom provider

Ask for:
1. API endpoint URL (must be OpenAI-compatible)
2. API key

```bash
export QMD_OPENAI_API_KEY=user-key
export QMD_OPENAI_BASE_URL=https://their-endpoint.com/v1
export QMD_EMBED_PROVIDER=openai
```

Test connectivity:
```bash
curl -s "$QMD_OPENAI_BASE_URL/models" -H "Authorization: Bearer $QMD_OPENAI_API_KEY" | head -5
```

### Configure embedding model

Default: `Qwen/Qwen3-Embedding-8B` (on SiliconFlow, free)

Ask:
> Keep the default embedding model (`Qwen/Qwen3-Embedding-8B`), or choose your own?
>
> If you don't know which to pick, the default is good.

If user wants to change:
```bash
export QMD_SILICONFLOW_EMBED_MODEL=their-chosen-model
# or for custom provider:
export QMD_OPENAI_EMBED_MODEL=their-chosen-model
```

### Configure embedding dimensions

> Do you know the output dimensions of your embedding model?
>
> 1. **Use default** (auto-detect from model — recommended)
> 2. **I know the dimensions** — let me enter it
> 3. **I don't know** — please look it up for me

If option 3: search the web for "{model_name} embedding dimensions" and inform the user.

Note: If dimensions change after initial indexing, user must run `qmd embed -f` to rebuild.

### Configure chunk size

Default: `200` tokens per chunk, `40` tokens overlap.

> Chunk size controls how documents are split for embedding.
>
> - **Default: 200 tokens** (recommended for most use cases)
> - Larger chunks = more context per result, but less precise
> - Smaller chunks = more precise, but may lose context

```bash
# Only if user wants to change defaults:
export QMD_CHUNK_SIZE_TOKENS=200      # default
export QMD_CHUNK_OVERLAP_TOKENS=40    # default
```

---

## Phase 4: Configure Query Expansion

Query expansion rewrites the user's search query into multiple variations (keyword + semantic + hypothetical) to improve recall.

Default: `GLM-4.5-Air` on SiliconFlow (~¥1/month, fast, good quality).

Ask:
> Use the default query expansion model (`GLM-4.5-Air` on SiliconFlow), or use your own?
>
> 1. **Default** (GLM-4.5-Air on SiliconFlow — recommended)
> 2. **Use the reranking provider's model** (configured in next step)
> 3. **Custom** — I want to specify a model

If option 2: will be configured after Phase 5.

If option 3:
```bash
export QMD_QUERY_EXPANSION_PROVIDER=openai  # or gemini
# For OpenAI-compatible:
export QMD_OPENAI_MODEL=their-model-name
# For Gemini:
export QMD_GEMINI_API_KEY=their-key
```

---

## Phase 5: Configure Reranking

Reranking uses a large language model to judge which search results are truly relevant. This is where QMDR's quality advantage comes from — cloud LLMs are much better at this than the original QMD's 0.6B local model.

**Default: Gemini 2.5 Flash** with thinking budget set to 0 (fast, high quality, generous free tier).

> **Do you have a Gemini API key?**
>
> 1. **Yes** — I'll enter my key
> 2. **No** — show me how to get one
> 3. **Skip Gemini** — use SiliconFlow or my own model for reranking

### Option 1: User has Gemini key

```bash
export QMD_GEMINI_API_KEY=user-key
export QMD_RERANK_PROVIDER=gemini
```

### Option 2: Guide to get Gemini key

> Get a free Gemini API key at https://ai.google.dev
> 1. Sign in with Google account
> 2. Click "Get API key" → Create key
> 3. Free tier: 15 RPM / 1M tokens per day (more than enough for reranking)

Note for China users: Gemini API may require a proxy. If the user has a proxy:
```bash
export QMD_GEMINI_BASE_URL=https://their-proxy-endpoint
```

If no proxy available, recommend Option 3 instead.

### Option 3: Alternative reranking

**Using SiliconFlow LLM rerank (no extra key needed):**
```bash
export QMD_RERANK_PROVIDER=siliconflow
export QMD_RERANK_MODE=llm
```

**Using a dedicated rerank model API (e.g. BAAI/bge-reranker):**
```bash
export QMD_RERANK_PROVIDER=siliconflow
export QMD_RERANK_MODE=rerank
export QMD_SILICONFLOW_RERANK_MODEL=BAAI/bge-reranker-v2-m3
```

**Using OpenAI-compatible endpoint:**
```bash
export QMD_RERANK_PROVIDER=openai
export QMD_RERANK_MODE=llm
export QMD_OPENAI_API_KEY=their-key
export QMD_OPENAI_BASE_URL=https://their-endpoint/v1
```

For Claude Code / OpenCode users: you can reuse whichever model API you're already paying for.

### Model selection

Default reranking model: `gemini-2.5-flash` with `thinkingBudget: 0` (no reasoning overhead, pure relevance judgment).

> Keep the default reranking model (`gemini-2.5-flash`), or change it?

If user wants to change:
```bash
export QMD_GEMINI_MODEL=their-model      # for Gemini provider
export QMD_LLM_RERANK_MODEL=their-model  # for SiliconFlow/OpenAI LLM rerank
```

---

## Phase 6: Doctor Verification

Run the diagnostic:

```bash
qmd doctor
```

**Read the output carefully.** Check for:

| Status | Meaning | Action |
|--------|---------|--------|
| ✅ | Provider working | Good |
| ❌ | Provider failed | Fix config or key |
| Speed > 5s | Model is slow | Suggest switching to a faster/non-thinking model |

If any provider shows errors, go back to the relevant Phase and fix.

If speed > 5s for reranking or query expansion:
> Your {component} is taking {time}s — this may slow down searches. Consider switching to a faster model (non-thinking models like `gemini-2.5-flash` with thinkingBudget=0 are recommended).

Optional quality check:
```bash
qmd doctor --bench
```
This runs test queries and evaluates expansion quality.

---

## Phase 7: Client Integration

### OpenClaw

QMDR is a **native memory backend** for OpenClaw — no MCP needed. OpenClaw spawns QMDR directly.

**→ See [docs/setup-openclaw.md](docs/setup-openclaw.md) for detailed configuration.**

After setup, add this to `TOOLS.md` in the workspace:

```markdown
## Memory Search (QMDR)

- **Always use natural language** for memory_search queries — not keyword concatenation
- ✅ Good: "what did we discuss about the server migration last week"
- ❌ Bad: "server migration discussion last week"
- The hybrid pipeline (query expansion + vector + rerank) is optimized for natural language
- `memory_search` is an internal OpenClaw tool, never a shell command
```

### Claude Code

Install the QMDR skill:

```bash
mkdir -p ~/.claude/skills/qmdr
curl -sL https://raw.githubusercontent.com/uf-hy/qmdr/main/skills/qmdr/SKILL.md \
  -o ~/.claude/skills/qmdr/SKILL.md
```

After setup, add this to `CLAUDE.md` in the project root:

```markdown
## Memory Search (QMDR)

- Use `qmd query "natural language question"` for best results
- Always use natural language — not keyword concatenation
- ✅ Good: `qmd query "what authentication method did we decide on"`
- ❌ Bad: `qmd query "authentication method decision"`
- Use `qmd search` for fast keyword-only lookups
- Use `qmd get "#docid"` to retrieve full documents from search results
```

### OpenCode

Install the QMDR skill:

```bash
mkdir -p ~/.config/opencode/skills/qmdr
curl -sL https://raw.githubusercontent.com/uf-hy/qmdr/main/skills/qmdr/SKILL.md \
  -o ~/.config/opencode/skills/qmdr/SKILL.md
```

After setup, add this to `AGENTS.md` in the project root:

```markdown
## Memory Search (QMDR)

- Use `qmd query "natural language question"` for best results
- Always use natural language — not keyword concatenation
- ✅ Good: `qmd query "what authentication method did we decide on"`
- ❌ Bad: `qmd query "authentication method decision"`
- Use `qmd search` for fast keyword-only lookups
- Use `qmd get "#docid"` to retrieve full documents from search results
```

---

## Environment Variables Reference

| Variable | Default | Purpose |
|----------|---------|---------||
| **API Keys** | | |
| `QMD_SILICONFLOW_API_KEY` | — | SiliconFlow |
| `QMD_GEMINI_API_KEY` | — | Google Gemini |
| `QMD_OPENAI_API_KEY` | — | OpenAI-compatible |
| **Provider routing** | | |
| `QMD_EMBED_PROVIDER` | auto | `siliconflow` / `openai` |
| `QMD_QUERY_EXPANSION_PROVIDER` | auto | `siliconflow` / `gemini` / `openai` |
| `QMD_RERANK_PROVIDER` | auto | `siliconflow` / `gemini` / `openai` |
| `QMD_RERANK_MODE` | `llm` | `llm` (chat model) / `rerank` (dedicated rerank API) |
| **Custom endpoints** | | |
| `QMD_SILICONFLOW_BASE_URL` | `https://api.siliconflow.cn/v1` | SiliconFlow endpoint (international: use `api.siliconflow.com`) |
| `QMD_GEMINI_BASE_URL` | Google default | Custom Gemini endpoint |
| `QMD_OPENAI_BASE_URL` | `api.openai.com/v1` | Custom OpenAI endpoint |
| **Model overrides** | | |
| `QMD_SILICONFLOW_EMBED_MODEL` | `Qwen/Qwen3-Embedding-8B` | Embedding model |
| `QMD_SILICONFLOW_QUERY_EXPANSION_MODEL` | `zai-org/GLM-4.5-Air` | Query expansion |
| `QMD_SILICONFLOW_RERANK_MODEL` | `BAAI/bge-reranker-v2-m3` | Dedicated rerank model |
| `QMD_LLM_RERANK_MODEL` | `zai-org/GLM-4.5-Air` | LLM rerank model |
| `QMD_GEMINI_MODEL` | `gemini-2.5-flash` | Gemini model (thinkingBudget=0 by default) |
| `QMD_OPENAI_MODEL` | `gpt-4o-mini` | OpenAI chat model |
| `QMD_OPENAI_EMBED_MODEL` | `text-embedding-3-small` | OpenAI embed model |
| **Tuning** | | |
| `QMD_CHUNK_SIZE_TOKENS` | `200` | Tokens per chunk |
| `QMD_CHUNK_OVERLAP_TOKENS` | `40` | Overlap between chunks |
| `QMD_EMBED_BATCH_SIZE` | `32` | Embedding batch size |
| `QMD_RERANK_DOC_LIMIT` | `40` | Max docs for reranking |
| `QMD_RERANK_CHUNKS_PER_DOC` | `3` | Chunks per doc for reranking |
| **Paths** | | |
| `QMD_SQLITE_VEC_PATH` | auto | sqlite-vec native extension path |

**If you change the embedding model, run `qmd embed -f` to rebuild the vector index.**

## Troubleshooting

| Problem | Fix |
|---------|-----|
| `qmd: command not found` | `bun link`, ensure `~/.bun/bin` in PATH |
| sqlite-vec load error | macOS: `brew install sqlite`; or set `QMD_SQLITE_VEC_PATH` |
| sqlite-vec `/$bunfs/root/` error | Switch to source mode (bun install) instead of compiled binary |
| Dimension mismatch | `qmd embed -f` to rebuild with current model |
| Slow queries (>5s) | Run `qmd doctor` — switch to non-thinking models |
| `Script not found "query"` | Don't use `"bun /path/to/qmd.ts"` as command; use direct path with shebang |

## Links

- Original project: https://github.com/tobi/qmd
- SiliconFlow (China): https://cloud.siliconflow.cn
- SiliconFlow (International): https://cloud.siliconflow.com
- Gemini API: https://ai.google.dev
