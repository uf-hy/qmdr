# QMDR — QMD 远程版

> **[tobi/qmd](https://github.com/tobi/qmd) 的远程分支** — 用云端 API 替代本地 GGUF 模型，实现 embedding、查询扩展和重排序。

[English](../README.md)

---

## 🤖 给 AI 用的

**把下面这行复制到你的 AI 编程工具里：**

| 工具 | 安装方式 |
|------|---------|
| **OpenClaw** | 查看 [AI-SETUP.md](../AI-SETUP.md) → 配置 `memory.qmd` |
| **Claude Code** | `claude mcp add qmd -- qmd mcp` |
| **OpenCode** | 添加 MCP 配置（见 [AI-SETUP.md](../AI-SETUP.md#mcp-server-integration)） |
| **Claude Desktop** | 添加 MCP 配置（见 [AI-SETUP.md](../AI-SETUP.md#mcp-server-integration)） |
| **Cursor / Windsurf** | 添加 MCP 配置（见 [AI-SETUP.md](../AI-SETUP.md#mcp-server-integration)） |

**完整 AI 安装指南 → [AI-SETUP.md](../AI-SETUP.md)**

---

## 这是什么？

[QMD](https://github.com/tobi/qmd) 是一个 Markdown 文件的混合搜索引擎 — BM25 全文搜索 + 向量语义搜索 + LLM 重排序。非常适合给 AI 代理添加长期记忆。

**QMDR** 是它的远程版本：
- 🌐 **远程 LLM** — 支持硅基流动 (SiliconFlow)、Gemini、或任何 OpenAI 兼容 API
- ⚡ **无需本地模型** — 不用下载 GGUF，不需要 GPU
- 🔧 **20+ 环境变量** — 模型、端点、参数全部可配置
- 📦 **源码模式** — Bun 原生跑 TypeScript，零编译

## 安装

```bash
bun install -g github:uf-hy/qmdr
qmd doctor    # 检查配置
```

需要：[Bun](https://bun.sh) >= 1.0 · macOS 需要 `brew install sqlite`

## 快速开始

```bash
# 1. 设置 API Key（硅基流动有免费额度）
export QMD_SILICONFLOW_API_KEY=sk-你的密钥

# 2. 索引文件
qmd collection add ~/notes --name notes
qmd embed

# 3. 搜索
qmd query "上周写了什么"
```

## 致谢

基于 [QMD](https://github.com/tobi/qmd)，由 Tobias Lütke 开发。[MIT](../LICENSE) 协议。
