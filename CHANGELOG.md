# Changelog

## 0.2.4

修复 0.2.3 引入的线上崩溃与中文召回失效。

- **修复 `ReferenceError: FACT_TEXT_MAX is not defined`**：`src/fact-store.ts` 在 0.2.3 新增「单条事实落盘前截断」时引用了 `FACT_TEXT_MAX`，但常量从未定义/导入。导致任何走 `FactStore.add` 的路径（`mem_remember` / `mem_note` / `mem_profile` / 自动捕获 `captureIncoming`）一律抛错，且 `captureIncoming` 在 `facts.add` 处抛错后 `embedded()` 与 `vectors.add()` 不再执行、`lastCursor` 不推进，每 20s 轮询重复失败、同一批事件反复重跑。现补 `export const FACT_TEXT_MAX = 2000`（与召回端 `RECALL_ITEM_MAX = 1500` 形成双截断兜底）。
- **修复中文知识库召回恒空**：`src/knowledge-store.ts` 的 `recall` 中关键词匹配用了 `k.length >= 3`，把「凤凰」「代号」等 2 字中文关键词全部过滤；事实匹配又要求「整句事实是查询的子串」，几乎不可能命中。现改为阈值 `>= 2` + 双向子串匹配（`q.includes(k) || k.includes(q)`），事实匹配同样双向。
- **测试**：新增 `test/fact-knowledge.test.ts` 覆盖上述两个回归（`FACT_TEXT_MAX` 定义与截断、中文 2 字/反向子串召回、无关查询不误命中）；`npm test` 现在跑 snapshot + recall + fact-knowledge 三套。

## 0.2.3

- 修复召回上下文超长：单条展示上限 1500 字符、单次总预算 8000 字符、最多 20 条（`src/recall.ts`）。

## 0.2.2

- 修复记忆快照重复堆积：`SnapshotPusher` 按语义指纹去重，并对未投递快照做原位替换（`withdrawPending`），避免空闲期攒批后一次性打爆上下文。
