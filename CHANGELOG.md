# 更新日志

QMDR 的所有重要变更记录。

## [1.0.3] — 2026-02-13

### 新增
- `qmd query --profile` — 显示每步耗时明细（查询扩展、检索、重排），含耗时占比和毫秒数
- `qmd query --verbose` — 显示完整查询过程（默认精简输出，省 89% token）
- Dashscope 重排 provider（阿里百炼 qwen3-rerank，免费额度）
- Windows x64 和 macOS x64 (Intel) 二进制发布（共 5 平台）
- AI-SETUP.md 新增诊断工具章节和 Sessions 索引说明

### 安全修复
- symlink 逃逸防护：禁用 followSymlinks + realpath 校验不逃逸集合根目录
- sqlite 动态扩展加载默认禁用（需 QMD_ALLOW_SQLITE_EXTENSIONS=1 启用）
- bash -c update 命令加 --allow-run 门控
- 大小写不敏感文件系统路径检查（macOS/Windows）
- per-DB WeakSet 替换全局 boolean（多连接安全）
- vector 功能优雅降级（扩展禁用时不崩溃）
- rerank 不再修改共享 config 对象（并发安全）
- cache key 稳定排序序列化
- MCP decodeURIComponent 防崩溃
- 大文件/二进制文件索引跳过保护（默认 8MB 上限）
- QMD_MAX_INDEX_FILE_BYTES NaN 防护

### 变更
- `--profile` 输出改为中文紧凑 TSV 格式
- 统一 isVectorRuntimeAvailable() 判断（表存在 + 扩展启用）

### CI
- Full Code Audit workflow（GPT-5.2 xhigh 全量审计）
- OpenCode PR Review workflow（自动 code review）
- Nightly 回归测试层，附带日志归档
- PR quality gates
- Windows x64 + macOS x64 构建目标

---

## [1.0.2] — 2026-02-12

### 修复
- SiliconFlow LLM 重排路由修复，不再误路由到 openai.com
- FTS5 触发器在已有数据库上不更新的问题（改为 DROP + CREATE 替代 IF NOT EXISTS）
- 修复 LLM 和结果去重路径的严格类型检查
- 延迟加载 node-llama-cpp，避免 Linux CI 崩溃
- 锁定 Bun ≤ 1.3.6（1.3.7+ 存在 sqlite-vec 段错误）
- CI 中安装 libsqlite3-dev 修复 Linux sqlite-vec

---

## [1.0.0] — 2026-02-12

Fork 自 [QMD](https://github.com/tobi/qmd)，将本地 GGUF 模型替换为远程 API 调用。Embedding、查询扩展、重排全部走云端 LLM（SiliconFlow、Gemini、Dashscope 或任意 OpenAI 兼容 API）— 无需本地模型，无需 GPU。
