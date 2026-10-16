import type { ConfigGroup } from 'cortico/core/types.ts';

/**
 * 部署里 `worlds.memory` 配置段的形状。`ctx.cfg` 是它的活引用,热改即时生效
 * (改 embedding 端点等连接类键请走「重启」按钮,见 schema 的 x-hot 标注)。
 */
export interface MemoryConfig {
  /** 框架对账用,恒为 true(是否启用由部署的 worlds 列表决定)。 */
  enabled: boolean;
  [k: string]: unknown;
  /** 短期记忆窗口(每个 scope 保留的最近条数)。对齐 qq_bot 的 MAX_HISTORY。 */
  maxHistory: number;
  /** 每个 scope 的向量记录上限,超出截掉最旧的。对齐 MAX_VECTORS_PER_USER。 */
  maxVectorsPerScope: number;
  /** 记忆上下文(话题/摘要/要点)推送到事件流的周期(毫秒)。 */
  observeIntervalMs: number;
  /** 检索默认 top_k。 */
  vectorTopK: number;
  /** 环境提示词里常驻注入的「重要信息」条数上限。 */
  notesInPrompt: number;
  /**
   * 自动捕获:开启后周期扫描事件流,把外部入站用户消息自动沉淀进事实库/向量库。
   * world 无关——只认 `origin:'external'` 的入站事件,QQ 没开也能抓其它 world 的对话,
   * QQ 开了就自动沉淀 QQ 聊天(无需 bot 手动调 mem_remember)。
   */
  autoCapture: boolean;
  /** 自动捕获的轮询间隔(毫秒)。 */
  captureIntervalMs: number;
  /** 短于此长度的入站消息不沉淀(过滤表情/口令噪声)。 */
  captureMinLength: number;
  /**
   * 向量来源:
   *  - `off`     纯 BM25 关键词检索(零依赖,永远可用);
   *  - `http`    OpenAI 兼容 /embeddings 端点;
   *  - `sidecar` qq_bot 的 memory_server(POST {url}/call 调 vector_memory.generate_embedding)。
   * 任一模式失败都自动降级 BM25,与 qq_bot memory_client 的降级语义一致。
   */
  embeddingProvider: 'off' | 'http' | 'sidecar';
  /** `http` 模式的端点 URL(如本机 ollama: http://127.0.0.1:11434/v1/embeddings)。 */
  embeddingEndpoint: string;
  /** `http` 模式的模型名(如 nomic-embed-text)。 */
  embeddingModel: string;
  /** `sidecar` 模式的 qq_bot memory_server 地址(默认即其约定端口 8766)。 */
  embeddingSidecarUrl: string;
  /** `sidecar` 模式单次调用的超时(毫秒)。qq_bot 侧模型首载可达数分钟,别调太小。 */
  embeddingTimeoutMs: number;
  /**
   * 持久化后端:
   *  - `json`    原生 JSON 文件(每 store 一个 `*.json`,默认);
   *  - `sqlite`  单库 `memory.db` 的 KV 封装(自动尝试 better-sqlite3,缺失回退 Node 内置 node:sqlite)。
   * 首次切到 sqlite 会自动把已有 JSON 迁移进库;切回 json 以 JSON 文件为准(可能落后 sqlite 的后续写入)。
   */
  storageBackend: 'json' | 'sqlite';
}

export const MEMORY_DEFAULTS: MemoryConfig = {
  enabled: true,
  maxHistory: 30,
  maxVectorsPerScope: 500,
  observeIntervalMs: 30000,
  vectorTopK: 5,
  notesInPrompt: 10,
  autoCapture: true,
  captureIntervalMs: 20000,
  captureMinLength: 2,
  embeddingProvider: 'off',
  embeddingEndpoint: '',
  embeddingModel: '',
  embeddingSidecarUrl: 'http://127.0.0.1:8766',
  embeddingTimeoutMs: 180_000,
  storageBackend: 'json',
};

/** 控制台可调旋钮。一个属性一条 JSON Schema,没有手写表单。 */
export const MEMORY_CONFIG_GROUP: ConfigGroup = {
  id: 'world:memory',
  owner: 'world:memory',
  schema: {
    type: 'object',
    title: '记忆系统',
    description: '五层记忆(事实库/知识库/反思/人格/档案)+ 三级记忆底座(短期/摘要/话题)与 Hybrid Recall 向量混合检索(移植自 qq_bot)。',
    properties: {
      'worlds.memory.maxHistory': { type: 'number', title: '短期窗口(条)', description: '每个 scope 保留的最近对话条数。' },
      'worlds.memory.maxVectorsPerScope': { type: 'number', title: '向量上限(条/scope)', description: '超出截掉最旧的。' },
      'worlds.memory.observeIntervalMs': { type: 'number', title: '记忆推送周期(ms)', description: '把话题/摘要/要点推给人格的周期。', 'x-hot': true },
      'worlds.memory.vectorTopK': { type: 'number', title: '检索条数', description: 'mem_recall 默认返回条数。' },
      'worlds.memory.notesInPrompt': { type: 'number', title: '要点注入条数', description: '环境提示词常驻的「重要信息」上限。' },
      'worlds.memory.autoCapture': { type: 'boolean', title: '自动捕获对话', description: '周期扫描事件流,把外部入站用户消息自动沉淀进记忆(world 无关,QQ 没开也能用)。', 'x-hot': true },
      'worlds.memory.captureIntervalMs': { type: 'number', title: '捕获扫描周期(ms)', description: '自动捕获的轮询间隔,默认 20s。', 'x-hot': true },
      'worlds.memory.captureMinLength': { type: 'number', title: '捕获最小长度', description: '短于此长度的入站消息不沉淀。' },
      'worlds.memory.embeddingProvider': {
        type: 'string', title: '向量来源', enum: ['off', 'http', 'sidecar'],
        description: 'off=纯 BM25;http=OpenAI 兼容 /embeddings;sidecar=qq_bot memory_server。失败自动降级 BM25。',
      },
      'worlds.memory.embeddingEndpoint': { type: 'string', title: 'Embeddings 端点', description: "http 模式用,如 http://127.0.0.1:11434/v1/embeddings。" },
      'worlds.memory.embeddingModel': { type: 'string', title: 'Embeddings 模型', description: 'http 模式用,如 nomic-embed-text。' },
      'worlds.memory.embeddingSidecarUrl': { type: 'string', title: 'Sidecar 地址', description: 'sidecar 模式用,qq_bot memory_server(默认 http://127.0.0.1:8766)。' },
      'worlds.memory.embeddingTimeoutMs': { type: 'number', title: 'Sidecar 超时(ms)', description: 'qq_bot 向量模型首载慢,默认 3 分钟。' },
      'worlds.memory.storageBackend': {
        type: 'string', title: '存储后端', enum: ['json', 'sqlite'], 'x-hot': false,
        description: 'json=原生 JSON 文件(默认);sqlite=单库 KV(自动 better-sqlite3→node:sqlite 回退)。切 sqlite 首次自动迁移旧 JSON;切回 json 若 memory.db 数据更新会自动回填,不丢切换期间写入。改后须点「重启」生效。',
      },
    },
  },
};
