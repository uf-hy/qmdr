---
name: qmdr
description: Search personal markdown knowledge bases, notes, meeting transcripts, and documentation using QMDR - a remote-first hybrid search engine. Combines BM25 keyword search, vector semantic search, and cloud LLM re-ranking for high-quality recall. Use when users ask to search notes, find documents, look up information in their knowledge base, retrieve meeting notes, or search documentation. Triggers on "search markdown files", "search my notes", "find in docs", "look up", "what did I write about", "meeting notes about".
license: MIT
compatibility: Requires qmd CLI. Install via `bun install -g github:uf-hy/qmdr`. Bun ≤1.3.6 required (1.3.7+ has sqlite-vec segfault).
metadata:
  author: uf-hy
  version: "1.0.0"
allowed-tools: Bash(qmd:*), mcp__qmd__*
---

# QMDR - Quick Markdown Search (Remote)

QMDR is a remote-first search engine for markdown content. It indexes your notes, meeting transcripts, documentation, and knowledge bases for fast retrieval using cloud LLM providers.

Fork of [tobi/qmd](https://github.com/tobi/qmd) with remote API support (SiliconFlow, Gemini, OpenAI-compatible).

## QMD Status

!`qmd status 2>/dev/null || echo "Not installed. Run: bun install -g github:uf-hy/qmdr"`

## When to Use This Skill

- User asks to search their notes, documents, or knowledge base
- User needs to find information in their markdown files
- User wants to retrieve specific documents or search across collections
- User asks "what did I write about X" or "find my notes on Y"
- User needs semantic search (conceptual similarity) not just keyword matching
- User mentions meeting notes, transcripts, or documentation lookup

## Search Commands

Choose the right search mode for the task:

| Command | Use When | Speed |
|---------|----------|-------|
| `qmd search` | Exact keyword matches needed | Fast |
| `qmd vsearch` | Keywords aren't working, need conceptual matches | Medium |
| `qmd query` | Best results needed, speed not critical | Slower |

```bash
# Fast keyword search (BM25)
qmd search "your query"

# Semantic vector search (finds conceptually similar content)
qmd vsearch "your query"

# Hybrid search with re-ranking (best quality)
qmd query "your query"
```

## Common Options

```bash
-n <num>           # Number of results (default: 5)
-c, --collection   # Restrict to specific collection
--all              # Return all matches
--min-score <num>  # Minimum score threshold (0.0-1.0)
--full             # Show full document content
--json             # JSON output for processing
--files            # List files with scores
--line-numbers     # Add line numbers to output
```

## Document Retrieval

```bash
# Get document by path
qmd get "collection/path/to/doc.md"

# Get document by docid (shown in search results as #abc123)
qmd get "#abc123"

# Get with line numbers for code review
qmd get "docs/api.md" --line-numbers

# Get multiple documents by glob pattern
qmd multi-get "docs/*.md"

# Get multiple documents by list
qmd multi-get "doc1.md, doc2.md, #abc123"
```

## Index Management

```bash
# Check index status and available collections
qmd status

# Diagnose configuration and provider health
qmd doctor

# List all collections
qmd collection list

# List files in a collection
qmd ls <collection>

# Update index (re-scan files for changes)
qmd update
```

## Score Interpretation

| Score | Meaning | Action |
|-------|---------|--------|
| 0.8 - 1.0 | Highly relevant | Show to user |
| 0.5 - 0.8 | Moderately relevant | Include if few results |
| 0.2 - 0.5 | Somewhat relevant | Only if user wants more |
| 0.0 - 0.2 | Low relevance | Usually skip |

## ⚠️ Always Use Natural Language

QMDR's hybrid pipeline (query expansion + vector search + LLM reranking) is optimized for **natural language queries**, not keyword concatenation.

```bash
# ✅ Good — natural language
qmd query "what did we discuss about the server migration last week"
qmd query "how does the authentication flow work"

# ❌ Bad — keyword concatenation
qmd query "server migration discussion last week"
qmd query "authentication flow"
```

Natural language queries activate the full power of query expansion (lex + vec + hyde variations) and LLM reranking. Keyword-style queries still work but produce lower recall quality.

## Recommended Workflow

1. **Check what's available**: `qmd status`
2. **Use hybrid search first**: `qmd query "natural language question" --min-score 0.4`
3. **Fall back to keyword if needed**: `qmd search "exact term" -n 10`
4. **Try semantic for concepts**: `qmd vsearch "describe the concept"`
5. **Retrieve full documents**: `qmd get "#docid" --full`

## Example: Finding Meeting Notes

```bash
# Search for meetings about a topic
qmd search "quarterly review" -c meetings -n 5

# Get semantic matches
qmd vsearch "performance discussion" -c meetings

# Retrieve the full meeting notes
qmd get "#abc123" --full
```

## Example: Research Across All Notes

```bash
# Hybrid search for best results
qmd query "authentication implementation" --min-score 0.3 --json

# Get all relevant files for deeper analysis
qmd query "auth flow" --all --files --min-score 0.4
```

## MCP Server Integration

This plugin configures the qmd MCP server automatically. When available, prefer MCP tools over Bash for tighter integration:

| MCP Tool | Equivalent CLI | Purpose |
|----------|---------------|---------|
| `qmd_search` | `qmd search` | Fast BM25 keyword search |
| `qmd_vector_search` | `qmd vsearch` | Semantic vector search |
| `qmd_deep_search` | `qmd query` | Deep search with expansion and reranking |
| `qmd_get` | `qmd get` | Retrieve document by path or docid |
| `qmd_multi_get` | `qmd multi-get` | Retrieve multiple documents |
| `qmd_status` | `qmd status` | Index health and collection info |

For manual MCP setup without the plugin, see [references/mcp-setup.md](https://github.com/uf-hy/qmdr/blob/main/skills/qmdr/references/mcp-setup.md).
