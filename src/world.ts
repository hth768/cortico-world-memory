import { readFileSync, statSync, writeFileSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import type { World, WorldHost, ToolDef, ToolTag, ToolSpec, EventEnvelope } from 'cortico/core/types.ts';
import type { WorldContext } from 'cortico/world.ts';
import { MEMORY_DEFAULTS, type MemoryConfig } from './config.ts';
import { MEMORY_CONFIG_GROUP } from './config.ts';
import { MemoryBase } from './memory.ts';
import { EmbeddingClient } from './embedding.ts';
import { VectorStore } from './vector-store.ts';
import { FactStore } from './fact-store.ts';
import { KnowledgeStore } from './knowledge-store.ts';
import { ReflectionStore } from './reflection-store.ts';
import { PersonaStore } from './persona-store.ts';
import { ProfileStore } from './profile-store.ts';
import { createBackend, StoreBackend, ALL_STEMS, backfillSqliteToJson } from './backend.ts';
import { buildEventText, buildView, promptVars } from './observe.ts';

const ENV_PROMPT_FILE = fileURLToPath(new URL('./ENV_PROMPT.md', import.meta.url));

type _Dict = Record<string, any>;

/** 仅保留对象中指定 key 的条目(用于按 scope 过滤)。 */
function pickScope(obj: _Dict, key: string): _Dict {
  if (obj && typeof obj === 'object' && key in obj) return { [key]: obj[key] };
  return {};
}

/** 把导出 bundle 渲染为易读 Markdown。 */
function renderMemoryMarkdown(b: _Dict): string {
  const L: string[] = [];
  const profiles = (b.profiles ?? {}) as _Dict;
  const profKeys = Object.keys(profiles);
  const store = (b.memory?.store ?? {}) as _Dict;
  const storeKeys = Object.keys(store);
  const summary = (b.memory?.summary ?? {}) as _Dict;
  const topic = (b.memory?.topic ?? {}) as _Dict;
  const notes = (b.memory?.notes ?? {}) as _Dict;
  const noteKeys = Object.keys(notes);
  const factScopes = (b.facts?.scopes ?? {}) as _Dict;
  const factKeys = Object.keys(factScopes);
  const knowledge = (b.knowledge?.entries ?? []) as any[];
  const reflections = (b.reflection?.reflections ?? []) as any[];
  const rules = (b.reflection?.rules ?? []) as any[];
  const personas = (b.persona?.personas ?? {}) as _Dict;
  const personaKeys = Object.keys(personas);
  const vectors = (b.vectors?.vectors ?? []) as any[];

  L.push('# 记忆导出');
  L.push('');
  L.push(`- 导出时间：${b.exportedAt ?? ''}`);
  L.push(`- 作用域：${b.scope ?? 'ALL'}`);
  L.push(`- 存储后端：${b.backend ?? 'unknown'}`);
  L.push('');

  if (profKeys.length) {
    L.push(`## 人物档案 (${profKeys.length})`);
    for (const u of profKeys) {
      L.push(`### ${u}`);
      for (const f of profiles[u]?.facts ?? []) L.push(`- ${f}`);
    }
    L.push('');
  }
  if (storeKeys.length) {
    L.push(`## 短期记忆 (${storeKeys.length} scope)`);
    for (const s of storeKeys) {
      L.push(`### scope: ${s}`);
      for (const it of store[s] ?? []) L.push(`- [${it.role ?? ''}] ${it.content ?? ''}`);
    }
    L.push('');
  }
  const sumKeys = Object.keys(summary);
  if (sumKeys.length || Object.keys(topic).length) {
    L.push('## 总结与主题');
    for (const s of sumKeys) { L.push(`### ${s} 总结`); L.push(summary[s] ?? ''); }
    for (const s of Object.keys(topic)) { L.push(`### ${s} 主题`); L.push(topic[s] ?? ''); }
    L.push('');
  }
  if (noteKeys.length) {
    L.push(`## 笔记 (${noteKeys.length})`);
    for (const s of noteKeys) {
      L.push(`### ${s}`);
      for (const n of notes[s] ?? []) L.push(`- ${n.text ?? ''}`);
    }
    L.push('');
  }
  if (factKeys.length) {
    L.push(`## 事实库 (${factKeys.length} scope)`);
    for (const s of factKeys) {
      L.push(`### ${s}`);
      for (const f of factScopes[s] ?? []) L.push(`- ${f.text ?? ''}`);
    }
    L.push('');
  }
  if (knowledge.length) {
    L.push(`## 知识库 (${knowledge.length})`);
    for (const e of knowledge) {
      L.push(`### ${e.topic ?? ''}`);
      if (e.keywords?.length) L.push(`关键词：${e.keywords.join(', ')}`);
      for (const f of e.facts ?? []) L.push(`- ${f}`);
    }
    L.push('');
  }
  if (reflections.length || rules.length) {
    L.push(`## 反思与交互规则 (${reflections.length}/${rules.length})`);
    for (const r of reflections) L.push(`- [${r.type}] (${r.userId}) ${r.content ?? ''}`);
    if (rules.length) {
      L.push('### 交互规则');
      for (const r of rules) L.push(`- (${r.userId}) ${r.rule ?? ''}`);
    }
    L.push('');
  }
  if (personaKeys.length || b.persona?.globalStyle) {
    L.push(`## 人格记忆 (${personaKeys.length})`);
    if (b.persona?.globalStyle) L.push(`全局风格：${b.persona.globalStyle}`);
    for (const u of personaKeys) {
      L.push(`### ${u}`);
      L.push(`风格：${personas[u]?.style ?? ''}`);
      for (const t of personas[u]?.traits ?? []) L.push(`- ${t}`);
    }
    L.push('');
  }
  if (vectors.length) {
    L.push(`## 向量记忆 (${vectors.length}, 模型：${b.vectors?.model ?? '未知'})`);
    for (const v of vectors) {
      const txt = typeof v.text === 'string' ? v.text : JSON.stringify(v.text);
      L.push(`- [${v.scope}] ${txt.slice(0, 200)}`);
    }
    L.push('');
  }
  return L.join('\n');
}

/** 清理自动捕获的入站文本:去掉 QQ 的「【QQ群 ...】」前缀(对其它 world 无前缀,无副作用),压缩空白。 */
function cleanCaptureText(t: string): string {
  return (t ?? '')
    .replace(/^【[^】]*】\s*/u, '')
    .replace(/\s+/g, ' ')
    .trim();
}

/** 自动捕获时判断事件是否为「真人入站消息」(world 无关:只认 origin='external' + 非 bot 自言)。 */
function isInboundUser(e: EventEnvelope): boolean {
  if (e.origin !== 'external') return false; // 排除 internal 回灌 / 记忆自身推送
  const role = (e.meta?.role as string) ?? '';
  if (role === 'assistant' || role === 'bot' || e.meta?.self === true) return false; // 排除 bot 自己
  return true;
}

/**
 * 自动捕获的记忆域(scope):优先按「发送者 QQ 号」,做到私聊↔群聊按人统一——
 * 同一个人无论是在私聊还是群聊发言,记忆都沉淀到同一个 `qq:<号>` 域,无缝衔接。
 * 仅在事件确实来自 QQ 世界(e.source==='qqbot',qq-better 注入 meta.user=QQ号)时才用 qq: 前缀,
 * 避免把其它世界的数字 user 误标成 qq:;QQ 没启动则无 qq 事件,自然退化为其它域(世界无关)。
 * 非 QQ 来源退化为「来源:user」(若有 meta.user)→ 会话地址(senderKey)→ 来源(source)→ main。
 */
function scopeOfEvent(e: EventEnvelope): string {
  const meta = (e.meta ?? {}) as Record<string, any>;
  const src = typeof e.source === 'string' ? e.source : '';
  const isQQ = src === 'qqbot';

  // 1. QQ 来源:用发送者 QQ 号做按人统一域(私聊↔群聊无缝衔接)
  if (isQQ) {
    const u = meta.user;
    if (typeof u === 'number' && Number.isFinite(u)) return `qq:${u}`;
    if (typeof u === 'string' && /^\d{4,}$/.test(u.trim())) return `qq:${u.trim()}`;
    const s = meta.sender;
    if (typeof s === 'string') {
      const m = s.match(/QQ[:：]\s*(\d{4,})/);
      if (m) return `qq:${m[1]}`;
    }
  }

  // 2. 其它世界:若提供了 meta.user,按「来源:user」隔离(不同世界用户号避免撞车)
  const u = meta.user;
  if (typeof u === 'number' && Number.isFinite(u)) return `${src || 'user'}:${u}`;
  if (typeof u === 'string' && u.trim()) return `${src || 'user'}:${u.trim()}`;

  // 3. 退化:会话地址 → 来源 → main
  if (typeof e.senderKey === 'string' && e.senderKey.trim()) return e.senderKey.trim();
  if (src) return src;
  return 'main';
}

export class MemoryWorld implements World {
  readonly id = 'memory';
  private host: WorldHost | null = null;
  private timer: ReturnType<typeof setInterval> | null = null;
  private seq = 0;
  private mem: MemoryBase | null = null;
  private vectors: VectorStore | null = null;
  private facts: FactStore | null = null;
  private kb: KnowledgeStore | null = null;
  private reflect: ReflectionStore | null = null;
  private persona: PersonaStore | null = null;
  private profile: ProfileStore | null = null;
  private embedder: EmbeddingClient | null = null;
  private backend: StoreBackend | null = null; // 存储后端(json/sqlite),stop 时统一 flush 关闭
  private lastCursor = 0; // 自动捕获已扫到的事件游标(启动=当前尾,不回灌历史)
  private captureTimer: ReturnType<typeof setInterval> | null = null;

  constructor(private readonly ctx: WorldContext<MemoryConfig>) {}

  /** 环境提示词变量:要点/摘要/话题/统计,每轮上下文构建时现取(纯内存读)。 */
  envPromptVars(): Record<string, string> | null {
    if (!this.mem || !this.vectors) return null; // 未启动 = 本 World 这段不进前缀
    const view = buildView(this.mem, this.vectors, 'main', this.cfg.notesInPrompt, this.profile);
    // 合并 QQ 笔记本('qq' scope)的要点，让智能体也能常驻记住——qq_note_* 走记忆插件时落在此域。
    const qqNotes = this.mem.getNotes('qq').slice(-this.cfg.notesInPrompt);
    if (qqNotes.length) view.notes = [...view.notes, ...qqNotes].slice(-this.cfg.notesInPrompt);
    return promptVars(view);
  }

  private get cfg(): MemoryConfig {
    return this.ctx.cfg;
  }

  tools(): ToolDef[] {
    return Object.values(this.buildTools());
  }

  /** 自描述用:用一个未启动的实例读工具表,与 tools() 同源,名字不会分叉。 */
  static describeToolSpecs(): ToolSpec[] {
    // 只读工具声明,不触碰任何存储后端(buildTools 里的资源访问都在 handler 闭包中)。
    const ctx = {
      id: 'memory',
      cfg: { ...MEMORY_DEFAULTS },
      timezone: 'UTC',
      botName: '',
      botDir: '',
      packageDir: '',
      dataDir: '',
      repoRoot: '',
      secret: () => '',
      storeSecret: () => {},
      persist: () => {},
      restart: async () => {},
    } as unknown as WorldContext<MemoryConfig>;
    return Object.values(new MemoryWorld(ctx).buildTools()) as ToolSpec[];
  }

  webUi() {
    return {
      config: [MEMORY_CONFIG_GROUP], // 在「记忆系统」分组下渲染全部旋钮(含存储后端切换)
      promptDocs: [
        {
          key: 'worlds.memory.envPrompt',
          title: '记忆系统 · 环境提示词',
          description: '进 system 前缀的那一段:记忆库的使用纪律与动态记忆上下文。',
          path: ENV_PROMPT_FILE,
          role: 'envPrompt',
          vars: [
            { name: 'memoryContext', description: '重要信息/摘要/话题/统计 的拼接文本' },
            { name: 'memoryScopes', description: '现存记忆域列表' },
            { name: 'memoryVectors', description: '向量索引覆盖数/总数' },
          ],
        },
      ],
    };
  }

  async start(host: WorldHost): Promise<void> {
    this.host = host;
    const ctxData = this.ctx.dataDir;
    const dataDir = typeof ctxData === 'string' && ctxData ? ctxData : '.';
    const kind = this.cfg.storageBackend ?? 'json';
    this.backend = await createBackend(kind, dataDir, (m) => host.log.info(m));
    if (kind === 'sqlite') {
      this.backend.migrateFromJson(ALL_STEMS); // json→sqlite:首次自动迁移旧 JSON
    } else {
      await backfillSqliteToJson(dataDir, (m) => host.log.info(m)); // sqlite→json:回填较新数据,消除切换丢写
    }
    this.mem = new MemoryBase(dataDir, this.cfg.maxHistory, this.backend);
    this.vectors = new VectorStore(dataDir, this.backend);
    this.facts = new FactStore(dataDir, this.backend);
    this.kb = new KnowledgeStore(dataDir, this.backend);
    this.reflect = new ReflectionStore(dataDir, this.backend);
    this.persona = new PersonaStore(dataDir, this.backend);
    this.profile = new ProfileStore(dataDir, this.backend);
    this.embedder = new EmbeddingClient(this.cfg);

    host.log.info('[memory] 启动', {
      dataDir,
      maxHistory: this.cfg.maxHistory,
      embedding: this.cfg.embeddingProvider,
    });
    if (this.cfg.embeddingProvider === 'sidecar') {
      const ok = await this.embedder.sidecarHealthy();
      host.log.info('[memory] sidecar 探测', ok === true ? '在线' : '不在线(自动只用 BM25)');
    }

    this.timer = setInterval(() => {
      this.push('memory.context', buildEventText(this.view()));
    }, Math.max(10_000, this.cfg.observeIntervalMs));

    this.push('memory.context', buildEventText(this.view()));

    // 自动捕获:从当前事件尾开始(不回灌历史),周期扫描外部入站消息沉淀进记忆。
    try { this.lastCursor = (host.store?.latestCursor?.() ?? 0) || 0; } catch { this.lastCursor = 0; }
    if (this.cfg.autoCapture) this.startCapture();
    // QQ 插件笔记本桥：启用时让 qq_note_* 直接写入本插件笔记库('qq' scope)，复用常驻环境提示词与混合检索。
    (globalThis as Record<string, unknown>)['cortico:memory:notebook'] = {
      kind: 'memory' as const,
      save: (text: string) => this.mem!.addNote('qq', text),
      list: () => this.mem!.getNotes('qq'),
      get: (index: number) => this.mem!.getNotes('qq')[index] ?? null,
      forget: (index: number) => this.mem!.removeNote('qq', index),
    };
  }

  /** stop 必须 async 返回 Promise(框架 withDeadline 直接 work.then)。 */
  async stop(): Promise<void> {
    delete (globalThis as Record<string, unknown>)['cortico:memory:notebook'];
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    if (this.captureTimer) { clearInterval(this.captureTimer); this.captureTimer = null; }
    this.mem?.flush();
    this.vectors?.flush(); // 防抖写盘强制落盘
    this.facts?.flush();
    this.kb?.flush();
    this.reflect?.flush();
    this.persona?.flush();
    this.profile?.flush();
    this.backend?.flush(); // 最后统一关闭 SQLite(每个 store 的 flush 只写行,不关库)
  }

  /**
   * 导出全部记忆为 JSON / Markdown 文件(便于备份、迁移、阅读)。
   * - format: 'json' | 'markdown' | 'both'
   * - scope: 可选,按作用域/用户过滤(短期/事实/向量按 scope;反思/人格/档案按 userId;知识库为全局始终包含)
   * - outDir: 导出目录,默认 <dataDir>/exports
   */
  private async exportMemory(format: string, scope: string, outDir: string): Promise<{ text: string }> {
    const wantJson = !format || format === 'both' || format === 'json';
    const wantMd = !format || format === 'both' || format === 'markdown';
    const dir = (outDir && outDir.trim()) || path.join(this.dataDir, 'exports');
    mkdirSync(dir, { recursive: true });

    const read = async (stem: string): Promise<_Dict> => {
      try { return (await this.backend!.readJson(stem)) as _Dict; } catch { return {}; }
    };

    const memRaw = (await read('memory-data')) ?? {};
    const factRaw = (await read('fact-store')) ?? {};
    const vectorRaw = (await read('vector-memory')) ?? {};
    const kbRaw = (await read('knowledge-base')) ?? {};
    const reflRaw = (await read('reflection-data')) ?? {};
    const personaRaw = (await read('persona-data')) ?? {};
    const profileRaw = (await read('user-profiles')) ?? {};

    let store = (memRaw.store ?? {}) as _Dict;
    let notes = (memRaw.notes ?? {}) as _Dict;
    let summary = (memRaw.summary ?? {}) as _Dict;
    let topic = (memRaw.topic ?? {}) as _Dict;
    let factScopes = (factRaw.scopes ?? {}) as _Dict;
    let vectors = (vectorRaw.vectors ?? []) as any[];
    let reflections = (reflRaw.reflections ?? []) as any[];
    let rules = (reflRaw.interactionRules ?? []) as any[];
    let personas = (personaRaw.personas ?? {}) as _Dict;
    let profiles = (profileRaw.profiles ?? {}) as _Dict;
    const globalStyle = (personaRaw.globalStyle ?? '') as string;
    const knowledge = (kbRaw.entries ?? []) as any[];

    const filterScope = (scope || '').trim();
    if (filterScope) {
      store = pickScope(store, filterScope);
      notes = pickScope(notes, filterScope);
      summary = pickScope(summary, filterScope);
      topic = pickScope(topic, filterScope);
      factScopes = pickScope(factScopes, filterScope);
      vectors = vectors.filter((v: _Dict) => v.scope === filterScope);
      reflections = reflections.filter((r: _Dict) => String(r.userId) === filterScope);
      rules = rules.filter((r: _Dict) => String(r.userId) === filterScope);
      personas = pickScope(personas, filterScope);
      profiles = pickScope(profiles, filterScope);
    }

    const bundle: _Dict = {
      exportedAt: new Date().toISOString(),
      plugin: 'cortico-world-memory',
      scope: filterScope || 'ALL',
      backend: (this.backend as unknown as { constructor?: { name?: string } })?.constructor?.name ?? 'unknown',
      memory: { store, summary, topic, notes },
      facts: { scopes: factScopes },
      vectors: { model: vectorRaw.model_name ?? null, vectors },
      knowledge: { entries: knowledge },
      reflection: { reflections, rules, stats: reflRaw.stats ?? {} },
      persona: { personas, globalStyle },
      profiles,
    };

    const stamp = new Date().toISOString().replace(/[:.]/g, '-').replace('T', '_').slice(0, 19);
    const base = `memory-export-${stamp}`;
    const written: string[] = [];

    if (wantJson) {
      const p = path.join(dir, `${base}.json`);
      writeFileSync(p, JSON.stringify(bundle, null, 2), 'utf8');
      written.push(p);
    }
    if (wantMd) {
      const p = path.join(dir, `${base}.md`);
      writeFileSync(p, renderMemoryMarkdown(bundle), 'utf8');
      written.push(p);
    }

    const factCount = Object.values(factScopes).reduce((s: number, l: any) => s + (Array.isArray(l) ? l.length : 0), 0);
    const counts = [
      `短期记忆 ${Object.keys(store).length} scope`,
      `笔记 ${Object.keys(notes).length}`,
      `事实 ${factCount} 条`,
      `向量 ${vectors.length}`,
      `知识 ${knowledge.length} 条`,
      `反思 ${reflections.length} / 规则 ${rules.length}`,
      `人格 ${Object.keys(personas).length} 用户`,
      `档案 ${Object.keys(profiles).length} 用户`,
    ].join(' | ');

    return {
      text: `记忆导出完成（${filterScope ? 'scope=' + filterScope : '全部'}）\n${counts}\n文件：\n` + written.map((w) => '- ' + w).join('\n'),
    };
  }

  /** 启动自动捕获轮询(尊重暂停开关)。 */
  private startCapture(): void {
    const ms = Math.max(5000, Number(this.cfg.captureIntervalMs) || 20000);
    if (this.captureTimer) clearInterval(this.captureTimer);
    this.captureTimer = setInterval(() => { void this.captureIncoming(); }, ms);
    this.captureTimer.unref?.();
  }

  /**
   * 扫描事件流、把外部入站用户消息自动沉淀进事实库/向量库。
   * world 无关:只认 `origin:'external'` + 非 bot 自言——QQ 没开时抓其它 world,QQ 开了就自动沉淀 QQ 聊天。
   * 记忆自身的 internal 推送不在此列(被 origin 过滤),不会自我循环捕获。
   * 返回本次新增条数。
   */
  private async captureIncoming(): Promise<number> {
    const host = this.host;
    if (!host) return 0;
    if (host.isPaused?.() === true) return 0; // 与框架暂停语义一致
    const store = host.store;
    if (!store || !store.range) return 0;
    const to = (store.latestCursor?.() ?? this.lastCursor) || 0;
    if (!Number.isFinite(to) || to <= this.lastCursor) return 0;
    const events = (store.range({ fromCursor: this.lastCursor + 1, toCursor: to }) ?? []) as EventEnvelope[];
    let captured = 0;
    for (const e of events) {
      if (!isInboundUser(e)) continue;
      const text = cleanCaptureText(e.text ?? '');
      if (text.length < (this.cfg.captureMinLength ?? 2)) continue;
      // scope 优先按发送者 QQ 号(私聊↔群聊按人统一);非 QQ 来源退化为会话地址/来源。
      const scope = scopeOfEvent(e);
      this.facts!.add(scope, [text]);
      const vec = this.cfg.embeddingProvider === 'off' ? null : await this.embedder!.embed(text);
      this.vectors!.add(scope, text, vec, this.cfg.maxVectorsPerScope);
      captured++;
    }
    this.lastCursor = to;
    if (captured > 0) { this.facts!.flush(); this.vectors!.flush(); }
    return captured;
  }

  private view() {
    return buildView(this.mem!, this.vectors!, 'main', this.cfg.notesInPrompt, this.profile);
  }

  private push(type: string, text: string) {
    if (!this.host) return;
    this.seq += 1;
    // 内部事件+piggyback:记忆快照进会话历史但不唤醒回合,否则每个周期会触发生成让 bot 自言自语。
    this.host.pushEvent({
      type,
      ts: new Date().toISOString(),
      source: this.id,
      origin: 'internal',
      text,
    }, { trigger: 'piggyback' }).catch(() => {});
  }

  // ---- 工具表:mem_ 前缀(框架内工具名全局唯一,避开 mc_*/其它 World) ----
  private buildTools(): Record<string, ToolDef> {
    const str = (title: string) => ({ type: 'string', title });
    const num = (title: string) => ({ type: 'number', title });
    const mk = (
      name: string,
      description: string,
      properties: Record<string, unknown>,
      required: string[],
      tags: ToolTag[],
      run: (a: Record<string, any>) => Promise<string>,
      extra: Partial<ToolDef> = {},
    ): ToolDef => ({
      name,
      description,
      parameters: { type: 'object', additionalProperties: false, properties, required },
      tags,
      handler: async (args) => {
        try { return await run(args); } catch (e: any) { return `⚠ 调用失败: ${e?.message ?? e}`; }
      },
      ...extra,
    });

    const scopeOf = (a: Record<string, any>) => (typeof a.scope === 'string' && a.scope.trim() ? a.scope.trim() : 'main');

    return {
      mem_remember: mk('mem_remember', '把一件值得长期记住的事写进记忆库(同时落「事实库」做去重重排 + 建向量索引,之后 mem_recall 可按语义找回)。', { text: str('内容'), scope: str('记忆域') }, ['text'], ['write'],
        async (a) => {
          const scope = scopeOf(a);
          const text = String(a.text);
          const added = this.facts!.add(scope, [text]); // 事实库:SHA-256 去重 + 原子落盘
          this.vectors!.add(scope, text, this.cfg.embeddingProvider === 'off' ? null : await this.embedder!.embed(text), this.cfg.maxVectorsPerScope);
          return added ? `OK 已记住(${scope}): ${text.slice(0, 80)}` : `OK 已存在,跳过重复(${scope})`;
        }),
      mem_recall: mk('mem_recall', '按语义+关键词混合检索长期记忆(事实库全文 + BM25+向量+RRF 融合),找旧账/回忆约定时用。scope 留空或填 main = 跨全部记忆域(含自动捕获的对话);填具体 scope 只搜该域;可填某人的 qq:<QQ号> 来检索 TA 在私聊与群聊里统一沉淀的记忆(私聊↔群聊无缝衔接)。', { query: str('查询'), top_k: num('条数'), scope: str('记忆域(留空=全部)') }, ['query'], ['read'],
        async (a) => {
          const scope = scopeOf(a);
          const topK = Math.min(20, Number(a.top_k) || this.cfg.vectorTopK);
          const query = String(a.query);
          const vector = this.cfg.embeddingProvider === 'off' ? null : await this.embedder!.embed(query);
          const global = scope === 'main'; // main = 搜全部域(对话域也含)
          const hits = global
            ? this.vectors!.hybridSearchAll(query, vector, topK)
            : this.vectors!.hybridSearch(scope, query, vector, topK);
          const facts = global ? this.facts!.recallAll(query, topK) : this.facts!.recall(scope, query, topK);
          // 合并两路结果,按 text 去重,事实库命中的优先(更精确)。
          const seen = new Set<string>();
          const out: string[] = [];
          for (const f of facts) if (!seen.has(f.text)) { seen.add(f.text); out.push(f.text); }
          for (const h of hits) if (!seen.has(h.text)) { seen.add(h.text); out.push(h.text); }
          if (!out.length) return `OK ${global ? '全部域' : scope} 里没有匹配「${query}」的记忆`;
          return `OK ${out.slice(0, topK).map((t, i) => `${i + 1}. ${t}`).join('\n')}`;
        }),
      mem_recent: mk('mem_recent', '回看本域最近的短期对话(最多 maxHistory 条)。', { n: num('条数'), scope: str('记忆域') }, [], ['read', 'snapshot'],
        async (a) => {
          const items = this.mem!.recent(scopeOf(a), Number(a.n) || 10);
          if (!items.length) return 'OK 短期记忆是空的';
          return `OK\n${items.map((it) => `${it.role}: ${it.content.slice(0, 120)}`).join('\n')}`;
        }),
      mem_overflow: mk('mem_overflow', '短期记忆快满时,取出最旧的一半条目(出窗),让它们被压缩进 mem_summary。', { scope: str('记忆域') }, [], ['act'],
        async (a) => {
          const items = this.mem!.overflowItems(scopeOf(a));
          if (!items) return 'OK 短期记忆还没满,无需压缩';
          return `OK 取出 ${items.length} 条:\n${items.map((it) => `${it.role}: ${it.content.slice(0, 120)}`).join('\n')}`;
        }),
      mem_summary: mk('mem_summary', '读或写本域的对话摘要。带 text 为写(建议先把 mem_overflow 取出的旧条目浓缩成一段);不带为读。', { text: str('摘要内容'), scope: str('记忆域') }, [], ['read', 'write'],
        async (a) => {
          const scope = scopeOf(a);
          if (typeof a.text === 'string' && a.text.trim()) {
            this.mem!.setSummary(scope, String(a.text));
            return `OK 摘要已更新(${scope})`;
          }
          const s = this.mem!.getSummary(scope);
          return s ? `OK 当前摘要: ${s}` : `OK ${scope} 还没有摘要`;
        }),
      mem_topic: mk('mem_topic', '读或写当前话题(话题切换时更新它,帮助上下文连贯)。', { text: str('话题内容'), scope: str('记忆域') }, [], ['read', 'write'],
        async (a) => {
          const scope = scopeOf(a);
          if (typeof a.text === 'string' && a.text.trim()) {
            this.mem!.setTopic(scope, String(a.text));
            return `OK 话题已更新(${scope})`;
          }
          const t = this.mem!.getTopic(scope);
          return t ? `OK 当前话题: ${t}` : `OK ${scope} 还没有设定话题`;
        }),
      mem_note: mk('mem_note', '记一条「重要信息」(用户明确要求记住的事/硬约束),它会常驻进环境提示词。', { text: str('内容'), scope: str('记忆域') }, ['text'], ['write'],
        async (a) => {
          const n = this.mem!.addNote(scopeOf(a), String(a.text));
          return `OK 重要信息 #${n} 已记录`;
        }),
      mem_notes: mk('mem_notes', '列出本域的全部「重要信息」及编号(编号用于 mem_forget_note)。', { scope: str('记忆域') }, [], ['read'],
        async (a) => {
          const notes = this.mem!.getNotes(scopeOf(a));
          if (!notes.length) return 'OK 还没有重要信息';
          return `OK\n${notes.map((n, i) => `${i + 1}. ${n.text}`).join('\n')}`;
        }),
      mem_forget_note: mk('mem_forget_note', '按编号(1 起)删掉一条「重要信息」。先 mem_notes 确认编号再用。', { index: num('编号'), scope: str('记忆域') }, ['index'], ['write'],
        async (a) => {
          const ok = this.mem!.removeNote(scopeOf(a), Number(a.index) - 1);
          return ok ? 'OK 已删除' : `FAIL 没有第 ${Number(a.index)} 条`;
        }),
      mem_knowledge: mk('mem_knowledge', '沉淀一条「通用知识」(联网学到的、主题化的知识条目,区别于 mem_remember 的零散事实)。同主题会合并,事实级去重,超量淘汰最旧。', { topic: str('主题'), facts: str('知识要点(多条用换行分隔)'), keywords: str('关键词(逗号分隔,可选)'), sources: str('来源(逗号分隔,可选)') }, ['topic', 'facts'], ['write'],
        async (a) => {
          const topic = String(a.topic ?? '').trim();
          const facts = String(a.facts ?? '').split('\n').map((s) => s.trim()).filter(Boolean);
          const keywords = (typeof a.keywords === 'string' ? a.keywords : '').split(/[,，]/).map((s) => s.trim()).filter(Boolean);
          const sources = (typeof a.sources === 'string' ? a.sources : '').split(/[,，]/).map((s) => s.trim()).filter(Boolean);
          const r = this.kb!.addEntry(topic, facts, keywords, sources);
          if (!r.ok) return 'FAIL 主题和要点不能为空';
          return `OK ${r.merged ? '已并入已有主题' : '新主题'}「${topic}」,新增 ${r.newFacts} 条事实,知识库共 ${r.total} 条`;
        }),
      mem_knowledge_fact: mk('mem_knowledge_fact', '把单条知识文本直接记进知识库(主题取前 30 字,自动提炼关键词)。', { content: str('知识内容') }, ['content'], ['write'],
        async (a) => {
          const r = this.kb!.addFact(String(a.content ?? ''));
          return r.ok ? `OK 已沉淀(${r.merged ? '并入已有主题' : '新主题'}),知识库共 ${r.total} 条` : 'FAIL 内容为空';
        }),
      mem_knowledge_recall: mk('mem_knowledge_recall', '回答问题前先查知识库,命中就直接复用(省去重复搜索)。返回最相关主题及要点。', { query: str('查询/问题'), top_k: num('条数') }, ['query'], ['read'],
        async (a) => {
          const hits = this.kb!.recall(String(a.query ?? ''), Math.min(10, Number(a.top_k) || 2));
          if (!hits.length) return 'OK 知识库里没有相关条目';
          return `OK 命中 ${hits.length} 条:\n` + hits.map((e) => {
            const lines = e.facts.map((f, i) => `${i + 1}. ${f}`).join('\n');
            return `◆ ${e.topic}（学习日期 ${e.learnedAt}）\n${lines}`;
          }).join('\n');
        }),
      mem_knowledge_list: mk('mem_knowledge_list', '列出知识库全部主题(及命中数),便于总览已沉淀的知识。', { limit: num('条数') }, [], ['read'],
        async (a) => {
          const entries = this.kb!.count();
          if (!entries) return 'OK 知识库还是空的';
          return `OK 知识库共 ${entries} 条主题`;
        }),
      mem_reflect: mk('mem_reflect', '沉淀一条「反思/交互偏好/纠错」(五维记忆之反思维):用户偏好(preference)、交互风格(style)、用户洞察(insight)、AI纠错(correction)、对话模式(pattern)。可执行的会被提炼为常驻交互规则。', { content: str('反思内容(一句话)'), type: str('类型:preference/style/insight/correction/pattern'), evidence: str('支撑证据/对话片段(可选)'), user_id: str('用户ID(默认 main)'), confidence: num('置信度0-1'), actionable: num('是否可执行(1/0)') }, ['content', 'type'], ['write'],
        async (a) => {
          const type = String(a.type ?? 'insight');
          if (!['preference', 'style', 'insight', 'correction', 'pattern'].includes(type)) return 'FAIL 类型必须是 preference/style/insight/correction/pattern 之一';
          const r = this.reflect!.reflect(
            String(a.content ?? ''),
            type as any,
            String(a.user_id ?? 'main'),
            typeof a.evidence === 'string' ? a.evidence : undefined,
            typeof a.confidence === 'number' ? Math.max(0, Math.min(1, a.confidence)) : 0.6,
            Number(a.actionable ?? 1) >= 1,
          );
          return r.added ? `OK 反思已沉淀(${type});可执行的已提炼为交互规则` : 'FAIL 内容为空或重复';
        }),
      mem_reflect_rules: mk('mem_reflect_rules', '列出已沉淀的交互规则(从可执行反思提炼,常驻指导后续交互)。', { user_id: str('用户ID(默认 main)') }, [], ['read'],
        async (a) => {
          const { rules } = this.reflect!.getFor(String(a.user_id ?? 'main'));
          if (!rules.length) return 'OK 还没有交互规则';
          return `OK 交互规则(${rules.length}):\n` + rules.map((r, i) => `${i + 1}. [${r.type}] ${r.rule} (置信 ${(r.confidence ?? 0).toFixed(2)})`).join('\n');
        }),
      mem_persona: mk('mem_persona', '记录与某用户的独特相处模式(五维记忆之人格维):特征列表 + 风格描述,per-user 隔离、特征去重、上限20。', { user_id: str('用户ID(默认 main)'), traits: str('相处特征(多条用换行或逗号分隔)'), style: str('整体风格描述(可选)') }, ['user_id', 'traits'], ['write'],
        async (a) => {
          const uid = String(a.user_id ?? 'main');
          const traits = String(a.traits ?? '').split(/[\n,，]/).map((s) => s.trim()).filter(Boolean);
          const r = this.persona!.update(uid, traits, typeof a.style === 'string' ? a.style : '');
          return `OK 已更新 ${uid} 的人格记忆,当前特征 ${r.traits} 条`;
        }),
      mem_persona_get: mk('mem_persona_get', '读取某用户的人格记忆(特征+风格),不存在则提示。', { user_id: str('用户ID(默认 main)') }, [], ['read'],
        async (a) => {
          const p = this.persona!.get(String(a.user_id ?? 'main'));
          if (!p) return 'OK 还没有这个人设记忆';
          const traits = p.traits.length ? p.traits.map((t, i) => `${i + 1}. ${t}`).join('\n') : '(无特征)';
          return `OK 人格记忆:\n特征:\n${traits}${p.style ? `\n风格: ${p.style}` : ''}`;
        }),
      mem_persona_global: mk('mem_persona_global', '设置/读取全局风格(跨用户统一的人格基调,可选)。', { style: str('全局风格(留空为读)') }, [], ['read', 'write'],
        async (a) => {
          if (typeof a.style === 'string' && a.style.trim()) {
            this.persona!.setGlobalStyle(a.style);
            return 'OK 全局风格已更新';
          }
          const g = this.persona!.getGlobalStyle();
          return g ? `OK 全局风格: ${g}` : 'OK 还没有设置全局风格';
        }),
      mem_profile: mk('mem_profile', '记/更新某用户的「人物档案」(永久记住的关键信息:称呼/身份/关系等),常驻进环境提示词。合并新事实+去重+上限50。', { user_id: str('用户ID(默认 main)'), facts: str('人物事实(多条用换行或逗号分隔)') }, ['user_id', 'facts'], ['write'],
        async (a) => {
          const uid = String(a.user_id ?? 'main');
          const facts = String(a.facts ?? '').split(/[\n,，]/).map((s) => s.trim()).filter(Boolean);
          const r = this.profile!.update(uid, facts);
          return `OK 已更新 ${uid} 人物档案,当前 ${r.total} 条`;
        }),
      mem_profile_replace: mk('mem_profile_replace', '整体替换某用户人物档案(用于纠错,例如用户说「别再叫我XX」)。', { user_id: str('用户ID(默认 main)'), facts: str('正确的人物事实(多条用换行或逗号分隔)') }, ['user_id', 'facts'], ['write'],
        async (a) => {
          const uid = String(a.user_id ?? 'main');
          const facts = String(a.facts ?? '').split(/[\n,，]/).map((s) => s.trim()).filter(Boolean);
          const r = this.profile!.replace(uid, facts);
          return `OK 已替换 ${uid} 人物档案,当前 ${r.total} 条`;
        }),
      mem_profile_get: mk('mem_profile_get', '读取某用户人物档案。', { user_id: str('用户ID(默认 main)') }, [], ['read'],
        async (a) => {
          const facts = this.profile!.get(String(a.user_id ?? 'main'));
          return facts.length ? `OK 人物档案:\n${facts.map((f, i) => `${i + 1}. ${f}`).join('\n')}` : 'OK 还没有人物档案';
        }),
      mem_stats: mk('mem_stats', '记忆库统计:记忆域/条数/向量索引覆盖/当前配置的向量来源。', {}, [], ['snapshot', 'read'],
        async () => {
          const stats = this.vectors!.stats();
          const sidecar = await this.embedder!.sidecarHealthy();
          return `OK ${JSON.stringify({
            scopes: stats.scopes,
            total: stats.total,
            indexed: stats.indexed,
            embedding: this.cfg.embeddingProvider,
            ...(sidecar !== null ? { sidecarOnline: sidecar } : {}),
            maxHistory: this.cfg.maxHistory,
          })}`;
        }),
      mem_capture_now: mk('mem_capture_now', '立刻扫描事件流,把自上次扫描以来的外部入站用户消息沉淀进记忆(自动捕获的手动触发,无需等轮询周期)。QQ 没开时也可抓其它 world 的对话。', {}, [], ['act'],
        async () => {
          const captured = await this.captureIncoming();
          return `OK 本次捕获 ${captured} 条;当前游标 ${this.lastCursor}`;
        }),
      mem_flush: mk('mem_flush', '把记忆立即落盘(平时自动防抖落盘,一般不用调)。', {}, [], ['act'],
        async () => { this.mem?.flush(); this.vectors?.flush(); this.facts?.flush(); this.kb?.flush(); this.reflect?.flush(); this.persona?.flush(); this.profile?.flush(); return 'OK 已落盘'; }),
      mem_export: mk(
        'mem_export',
        '把全部记忆导出为文件(JSON/Markdown),便于备份、迁移、阅读。知识库为全局始终包含;其他可按作用域/用户过滤。',
        {
          format: { type: 'string', optional: true, title: '格式', description: "json | markdown | both(默认 both)。" },
          scope: { type: 'string', optional: true, title: '作用域过滤', description: '可选,按作用域/用户过滤(短期/事实/向量按 scope;反思/人格/档案按 userId)。留空导出全部。' },
          outDir: { type: 'string', optional: true, title: '导出目录', description: '可选,文件保存目录,默认 <数据目录>/exports。' },
        },
        [],
        ['act'],
        async (args: _Dict) => {
          const format = typeof args.format === 'string' ? args.format.trim().toLowerCase() : 'both';
          const scope = typeof args.scope === 'string' ? args.scope.trim() : '';
          const outDir = typeof args.outDir === 'string' ? args.outDir.trim() : '';
          if (!['json', 'markdown', 'both'].includes(format)) return { text: '错误：format 只能是 json / markdown / both。' };
          return await this.exportMemory(format, scope, outDir);
        },
      ),
    };
  }
}
