# cortico-world-memory

Cortico World 扩展:把 `E:/qq_bot` 的记忆系统移植成框架内的一格 World。**qq_bot 源码零改动**。

## 移植对照

| qq_bot(源) | 本扩展(目标) | 说明 |
|---|---|---|
| `memory.py` `Memory` | `src/memory.ts` `MemoryBase` | 三级记忆:短期(cap 环形)/摘要/话题 + JSON 防抖落盘 + overflow 取半;`user:{id}` 统一键改为调用方 scope(默认 `main`) |
| `vector_memory.py` | `src/vector-store.ts` `VectorStore` | Hybrid Recall = BM25(CJK 2/3-gram,仅 query 建 DF)+ Cosine(预归一化点积)+ RRF(k=60);矩阵按 scope 缓存、版本号失效;存储同款 `base64(fp16)` JSON,可与 `E:/qq_bot/vector_memory.json` 互导 |
| `memory_server.py`(sidecar) | `src/embedding.ts` `EmbeddingClient` | 「重负载外置 + 掉线降级」同一语义:`sidecar` 模式直接 POST qq_bot memory_server 的 `/call` 调 `vector_memory.generate_embedding`;另有 `http`(OpenAI 兼容 /embeddings)与 `off`(纯 BM25);任一失败自动降级 BM25 |
| `memory_context.py` | `src/observe.ts` + `src/ENV_PROMPT.md` | 记忆上下文注入:走 envPrompt 插值(要点/摘要/话题常驻前缀)+ 周期 `memory.context` 事件 |
| `important_notes.py`(存取部分) | `MemoryBase.addNote/removeNote` + `mem_note` 工具 | 重要信息常驻进提示词,条数上限 `notesInPrompt` |

## 工具(人格可调用)

`mem_remember` / `mem_recall` / `mem_recent` / `mem_overflow` / `mem_summary` / `mem_topic` / `mem_note` / `mem_notes` / `mem_forget_note` / `mem_stats` / `mem_flush`

## 部署

1. 包放到 `Cortico/extensions/node_modules/cortico-world-memory/`;
2. `extensions/package.json` 的 dependencies 加 `"cortico-world-memory": "link:./node_modules/cortico-world-memory"`;
3. 部署 `config.json` 加 `worlds.memory.enabled = true`(或控制台激活);
4. **整机重启**(`POST /api/run/restart`)才加载新扩展包。

数据落在部署 `data/` 下:`memory-data.json`、`vector-memory.json`(均 gitignored)。

## 对接 qq_bot 向量 sidecar(可选)

不改 qq_bot 一行:在 `E:/qq_bot` 正常启动 `python memory_server.py`(默认 127.0.0.1:8766),
部署里设 `worlds.memory.embeddingProvider = "sidecar"` 即可复用它的 all-MiniLM-L6-v2 向量;
sidecar 不在线时本扩展自动只用 BM25,永不停摆。
