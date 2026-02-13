# 更新日志

QMDR 的所有重要变更记录。

## [未发布]

### 新增
- `qmd query` 新增 `--profile` 参数 — 显示每步耗时明细（查询扩展、检索、重排），含耗时占比和毫秒数
- 新增 Dashscope 重排 provider（阿里云免费额度）

### 变更
- `--profile` 输出改为中文紧凑 TSV 格式

### CI
- 新增 Nightly 回归测试层，附带日志归档
- 集成测试预检的 secrets 保护

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
