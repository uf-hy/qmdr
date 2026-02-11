# QMD 解耦重构 Checklist

> 目标：只做结构拆分，不改业务语义（Behavior-Preserving Refactor）。

## Phase 1：CLI 薄化

- [x] 盘点 `src/qmd.ts` 命令入口与对应函数映射（context/get/multi-get/collection/status/update/embed/search/vsearch/query/cleanup）。
- [x] 新建 `src/app/commands/` 目录（仅新增，不替换旧逻辑）。
- [ ] 将 `showStatus` 迁移到 `app/commands/status.ts`。
- [ ] 将 `getDocument` / `multiGet` 迁移到 `app/commands/document.ts`。
- [x] 将 `collection*` / `context*` 迁移到 `app/commands/collection.ts` / `context.ts`。
- [x] 将 `search` / `vectorSearch` / `querySearch` 迁移到 `app/commands/search.ts`。
- [ ] `src/qmd.ts` 保留 parseCLI + switch 路由 + process exit。
- [ ] 运行：`bun src/qmd.ts --help`、`bun test`、`bun src/qmd.ts status`。

## Phase 2：Store 模块化

- [x] 新建 `src/store/` 子模块：`db.ts`、`path.ts`、`documents.ts`、`search.ts`、`context.ts`、`collections.ts`、`maintenance.ts`。
- [ ] 将 schema/init/vec table 逻辑迁移到 `store/db.ts`。
- [ ] 将 FTS/vec/RRF/similar-file 逻辑迁移到 `store/search.ts`。
- [ ] 将 find/get/multi-get/docid/chunk 逻辑迁移到 `store/documents.ts`。
- [ ] 将 context/collection 逻辑按模块迁移。
- [ ] 在 `src/store.ts` 提供兼容 re-export，保持旧导入不报错。
- [ ] 回归：`bun test`、`bun src/qmd.ts get "nonexistent.md"`、`bun src/qmd.ts multi-get "*.md" --json`。

## Phase 3：LLM 门面化

- [x] 定义 `src/app/ports/llm.ts`（embed/expand/rerank/session 接口）。
- [x] 新建 `src/app/services/llm-service.ts`（统一 remote/local 策略）。
- [x] 从 `qmd.ts/store.ts` 移除直接 remote 判断，改走 llm-service（`qmd.ts` 已完成，`store.ts` 保留 provider 级策略）。
- [x] 保持 `src/llm.ts` 作为 provider 实现层（LlamaCpp/RemoteLLM/pull/session）。
- [ ] 为 query 流程补充输出结构快照测试（JSON shape）。
- [ ] 回归：`bun test`、`bun src/qmd.ts query "test" --json -n 3`、`bun src/qmd.ts vsearch "test" -n 3`。

## 收尾

- [ ] 更新 README 的架构图与模块说明。
- [ ] 合并前执行一次全量 smoke：`--help/status/search/query`。
- [ ] 记录回滚点（每 Phase 的最后一个稳定 commit）。

## Bug 修复（并行）

- [x] 修复 remote reranker 截断：`src/llm.ts` 中 SiliconFlow `top_n` 不再硬编码为 5，改为按候选数量动态设置。
- [x] 修复 chunk 级召回去重：`src/store.ts#searchVec` 不再按文件去重，改为保留 chunk 级结果。
- [x] 修复 query 阶段 top-1 chunk 偏置：`src/qmd.ts#querySearch` 每文档送 reranker 的 chunk 从 top-1 扩展为 top-N（当前 N=3）。

## 风险/回滚记录（当前批次）

- 风险 1：CLI 解耦仍是“薄路由 + 依赖注入”阶段，`qmd.ts` 中业务函数尚未完全迁出。
  - 回滚：删除 `src/app/commands/*` 新文件并恢复 `qmd.ts` switch 分支到内联逻辑。
- 风险 2：chunk 级召回会增加候选数量，可能带来 rerank 延迟抖动。
  - 回滚：在 `searchVec` 恢复 file-level dedupe；或将 `PER_DOC_CHUNK_LIMIT` 从 3 降到 1。
- 风险 3：SiliconFlow rerank `top_n` 改为动态后，返回规模可能变化。
  - 回滚：将 `top_n` 改回固定值（不建议），或设为受控上限 `Math.min(documents.length, N)`。
