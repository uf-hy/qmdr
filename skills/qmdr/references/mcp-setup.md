# QMDR MCP Server Setup

Manual MCP configuration for use without the qmdr skill/plugin.

> **Note**: If using the qmdr skill, MCP configuration is included automatically. This is only needed for manual setup.

## Claude Code

```bash
claude mcp add qmd -- qmd mcp
```

Or add to `~/.claude/settings.json`:

```json
{
  "mcpServers": {
    "qmd": {
      "command": "qmd",
      "args": ["mcp"]
    }
  }
}
```

## OpenCode

Add to `.opencode.json`:

```json
{
  "mcpServers": {
    "qmd": {
      "command": "qmd",
      "args": ["mcp"]
    }
  }
}
```

## Claude Desktop

Add to `~/Library/Application Support/Claude/claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "qmd": {
      "command": "qmd",
      "args": ["mcp"]
    }
  }
}
```

## Cursor / Windsurf

Add to your MCP configuration:

```json
{
  "mcpServers": {
    "qmd": {
      "command": "qmd",
      "args": ["mcp"]
    }
  }
}
```

## Available MCP Tools

| Tool | Purpose |
|------|---------|
| `qmd_search` | Fast BM25 keyword search |
| `qmd_vector_search` | Semantic vector search |
| `qmd_deep_search` | Hybrid search with expansion and reranking |
| `qmd_get` | Retrieve document by path or docid |
| `qmd_multi_get` | Retrieve multiple documents |
| `qmd_status` | Index health and collection info |

## Troubleshooting

| Problem | Fix |
|---------|-----|
| MCP server not starting | Ensure `qmd` is in PATH: `which qmd` |
| No results | Check `qmd status` and `qmd embed` |
| Slow first search | Normal — models/connections warming up |
