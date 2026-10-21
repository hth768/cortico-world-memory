# Changelog

## 0.2.7

在控制台暴露「清理捕获污染」的 GUI 入口(按用户要求:点击先预览,确认后再清理)。

- world 扩展的 `webUi()` 没有 `panels`(只有 Persona 有)、`config` 字段类型也无按钮类,无法在配置「表单」里直接加按钮。框架原生的清理入口是 `storage` 存储项:控制台渲染成数据标签里的「清除」按钮,`danger: true` 时点击弹出危险确认框,**预览文案写在 `note` 里随框展示**,确认后才执行 `clear()`。
- 据此在 `webUi().storage` 新增 `capture-pollution` 项:label「清理捕获污染(非真人消息)」,`stat()` 实时显示「疑似 N 条 / 共 M 条」,`note` 实时列出各记忆域条数并标注疑似非真人捕获域(预览),`clear()` 执行 `FactStore.purge(疑似域)`,删除不可撤销。
- 复用 0.2.6 的 `isSuspectScope` / `capturePollutionPreview` 共用方法(域命名启发式:`*.self` / `persona` / `*.touch` / `desktop-pet.*` 非 `.chat`),与 `mem_purge_capture` 工具行为一致。
- 注:按钮落在扩展页面的「数据」标签(框架对 world 清理动作的原生位置),而非严格意义的配置表单页。

## 0.2.6

新增「清理捕获污染」工具 `mem_purge_capture`（按用户意见:使用时征求同意）。

- 0.2.5 之前的事实库可能已被非真人消息污染(反馈实测约 64%)。本工具两步确认:
  1. **默认只预览**——列出每个记忆域(scope)的条数并标注疑似非真人捕获域(`*.self` / `persona` / `*.touch` / `desktop-pet.*` 非 `.chat`),**不删任何数据**;
  2. 仅当显式带 `confirm=1` 才真正删除;可指定 `scope`(逗号分隔)定点清理,留空则清理全部疑似域。删除不可撤销。
- `FactStore` 新增 `listScopes()` 与 `purge(scopes)`(删除即落盘,空数组安全不删)。
- 测试:新增 `test/fact-purge.test.ts`(10 项:listScopes/purge 计数/持久化/疑似域判定)。`npm test` 现跑六套。

## 0.2.5

依据用户反馈（world 扩展版本）修复两类长期存在的设计缺口。

### A. 事实库被非用户消息污染
`captureIncoming` 的判定 `isInboundUser` 之前只看 `origin` / `meta.role` / `meta.self`，而桌面端的「工具回执 / 桌宠自言 / 系统互动模板 / 交接笔记」这些事件 `origin` 也是 `external`、且三个旧信号恰好都缺失，导致约 64% 的非用户消息被当成「入站」塞进事实库。现改用 `senderKey` / `meta.kind` / `source` / `type` 黑名单（见 `src/capture-filter.ts`）：
- `senderKey` 以 `.self` 结尾（桌宠自言 + 工具回执）→ 排除
- `meta.kind ∈ {activity, delivered}`（做了:end_turn / 送达回执）→ 排除
- `source=desktop-pet && type=desktop-pet.touch`（摸头/拖动等互动模板）→ 排除
- `type=persona` 或 `senderKey=persona`（宿主生成的交接笔记）→ 排除
新事实库只收「真人入站」。

### B. 向量索引重复 embed + 历史 null 无回补
- **B1 重复 embed**：`captureIncoming` 与 `mem_remember` 之前不管事实库是否去重都无条件 `embed` + 写向量，导致同一事件反复捕获时反复烧 Ollama 窗口；且 `VectorStore.add` 自身不去重，与事实库逐渐漂移。现：事实库先 `add` 取新增条数，未新增则跳过 embed/向量写入；`VectorStore.add` 也按「前 200 字相同」去重；`captured` 计数改为「本次实际新增向量数」（之前虚报为事件数）。
- **B2 历史 null 无回补**：`embeddingProvider` 从 `off` 切到 `on` 后，off 期间产生的记录（反馈实测 723/1834）永远不会被建索引。现新增后台补索引任务：启动时稍候首跑 + 周期性低频限流（`max(30s, 捕获间隔×3)`，默认每轮 20 条），把 `vector:null` 的条目逐步补 embed；该任务在宿主暂停或向量关闭时自动让路。另加手动工具 `mem_backfill`（可调 `limit`），便于用户手动加速历史补建。
- 新增 `VectorStore.pendingVectors(limit)` / `setVector(scope, index, vec)` 作为补索引原语。

### 测试
新增 `test/capture-filter.test.ts`（11 项：真人入站 vs 各类非用户消息判定）、`test/vector-store.test.ts`（7 项：去重 / 前 200 字去重 / 上限截断 / 补索引扫描与原地补建）。`npm test` 现跑五套（snapshot + recall + fact-knowledge + capture-filter + vector-store）。

## 0.2.4

修复 0.2.3 引入的线上崩溃与中文召回失效。

- **修复 `ReferenceError: FACT_TEXT_MAX is not defined`**：`src/fact-store.ts` 在 0.2.3 新增「单条事实落盘前截断」时引用了 `FACT_TEXT_MAX`，但常量从未定义/导入。导致任何走 `FactStore.add` 的路径（`mem_remember` / `mem_note` / `mem_profile` / 自动捕获 `captureIncoming`）一律抛错，且 `captureIncoming` 在 `facts.add` 处抛错后 `embedded()` 与 `vectors.add()` 不再执行、`lastCursor` 不推进，每 20s 轮询重复失败、同一批事件反复重跑。现补 `export const FACT_TEXT_MAX = 2000`（与召回端 `RECALL_ITEM_MAX = 1500` 形成双截断兜底）。
- **修复中文知识库召回恒空**：`src/knowledge-store.ts` 的 `recall` 中关键词匹配用了 `k.length >= 3`，把「凤凰」「代号」等 2 字中文关键词全部过滤；事实匹配又要求「整句事实是查询的子串」，几乎不可能命中。现改为阈值 `>= 2` + 双向子串匹配（`q.includes(k) || k.includes(q)`），事实匹配同样双向。
- **测试**：新增 `test/fact-knowledge.test.ts` 覆盖上述两个回归（`FACT_TEXT_MAX` 定义与截断、中文 2 字/反向子串召回、无关查询不误命中）；`npm test` 现在跑 snapshot + recall + fact-knowledge 三套。

## 0.2.3

- 修复召回上下文超长：单条展示上限 1500 字符、单次总预算 8000 字符、最多 20 条（`src/recall.ts`）。

## 0.2.2

- 修复记忆快照重复堆积：`SnapshotPusher` 按语义指纹去重，并对未投递快照做原位替换（`withdrawPending`），避免空闲期攒批后一次性打爆上下文。
