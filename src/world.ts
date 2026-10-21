import { readFileSync, statSync, writeFileSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import type { World, WorldHost, ToolDef, ToolTag, ToolSpec, EventEnvelope } from 'cortico/core/types.ts';
import type { WorldContext } from 'cortico/world.ts';
import { MEMORY_DEFAULTS, type MemoryConfig } from './config.ts';
import { MEMORY_CONFIG_GROUP } from './config.ts';
import { MemoryBase } from './memory.ts';
import { EmbeddingClient } from './embedding.ts';
import { VectorStore } from './vector-store.ts';
import { FactStore } from './fact-store.ts';
import { KnowledgeStore } from './knowledge-store.ts';
import { isInboundUser } from './capture-filter.ts';
import { ReflectionStore } from './reflection-store.ts';
import { PersonaStore } from './persona-store.ts';
import { ProfileStore } from './profile-store.ts';
import { createBackend, StoreBackend, ALL_STEMS, backfillSqliteToJson } from './backend.ts';
import { buildBundle, writeBundleJson, writeBundleSqlite, readBundleFromFile, applyBundle, parseFormatTokens, type ImportMode, type ExportBundle, type ReadBundleResult } from './migrate.ts';
import { buildEventText, buildView, promptVars, snapshotSignature } from './observe.ts';
import { SnapshotPusher } from './snapshot.ts';
import { formatRecallResults } from './recall.ts';

const ENV_PROMPT_FILE = fileURLToPath(new URL('./ENV_PROMPT.md', import.meta.url));

type _Dict = Record<string, any>;

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
  const vectorMap = (b.vectors?.vectors ?? {}) as _Dict;
  const vectors = Object.keys(vectorMap).flatMap((sc) => (Array.isArray(vectorMap[sc]) ? (vectorMap[sc] as any[]) : []));

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
      for (const f of factScopes[s] ?? []) L.push(`- ${f.fact ?? f.text ?? ''}`);
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
  private backfillTimer: ReturnType<typeof setInterval> | null = null;
  // 记忆快照去重/原位替换。没有它时,30s 一拍会在总线上堆几十份完全相同的超长文本,
  // 等下一次唤醒整批投递 → 上下文爆炸(用户反馈 02:32→03:09)。
  private snapshot: SnapshotPusher | null = null;

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

  private get dataDir(): string {
    const d = (this.ctx as { dataDir?: unknown }).dataDir;
    return typeof d === 'string' && d ? d : '.';
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
      void this.pushContextSnapshot();
    }, Math.max(10_000, this.cfg.observeIntervalMs));

    void this.pushContextSnapshot(true);

    // 自动捕获:从当前事件尾开始(不回灌历史),周期扫描外部入站消息沉淀进记忆。
    try { this.lastCursor = (host.store?.latestCursor?.() ?? 0) || 0; } catch { this.lastCursor = 0; }
    if (this.cfg.autoCapture) this.startCapture();
    // 后台补索引(0.2.5,B2):embeddingProvider 非 off 时,周期性把历史 vector:null 的条目补 embed。
    // 解决「embeddingProvider 从 off 切到 on 后,off 期间产生的 723 条记录永远没索引」的问题。
    // 低频+限流(默认每轮 20 条),与捕获错开时间,避免一次性 700+ 次 embed 把本地 Ollama 打满。
    if (this.cfg.embeddingProvider !== 'off') {
      const capMs = Math.max(5_000, Number(this.cfg.captureIntervalMs) || 20_000);
      const bfMs = Math.max(30_000, capMs * 3);
      this.backfillTimer = setInterval(() => { void this.backfillVectors(20); }, bfMs);
      this.backfillTimer.unref?.();
      const kick = setTimeout(() => { void this.backfillVectors(20); }, 15_000); // 启动后稍等再首跑,错开初始化
      kick.unref?.();
    }
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
    if (this.backfillTimer) { clearInterval(this.backfillTimer); this.backfillTimer = null; }
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
   * 导出全部记忆为文件。导出与迁入共用同一套 cortico-memory-export 规范,支持三种落盘格式:
   * - json:   规范的 JSON 包(默认之一)
   * - markdown:易读 Markdown(渲染自同一 bundle,仅展示用)
   * - sqlite:  规范的 SQLite 包(结构与 json 完全一致,二者可互换)
   * format 可填 json / markdown / sqlite / both(json+md) / all(三者),或用逗号/竖线组合。
   * scope 可选,按作用域/用户过滤;知识库为全局始终包含。outDir 默认 <dataDir>/exports。
   */
  private async exportMemory(format: string, scope: string, outDir: string): Promise<{ text: string }> {
    const tokens = parseFormatTokens(format);
    if (tokens.size === 0) {
      return { text: '错误：format 只能是 json / markdown / sqlite / both / all（或以逗号、竖线组合的其中几种）。' };
    }
    const dir = (outDir && outDir.trim()) || join(this.dataDir, 'exports');
    mkdirSync(dir, { recursive: true });

    // 同一套规范 bundle —— json / markdown / sqlite 都从它派生
    const bundle = buildBundle(this.backend!, scope, this.backend!.kind);

    const stamp = new Date().toISOString().replace(/[:.]/g, '-').replace('T', '_').slice(0, 19);
    const base = `memory-export-${stamp}`;
    const written: string[] = [];

    if (tokens.has('markdown')) {
      const p = join(dir, `${base}.md`);
      writeFileSync(p, renderMemoryMarkdown(bundle as unknown as _Dict), 'utf8');
      written.push(p);
    }
    if (tokens.has('json')) {
      const p = join(dir, `${base}.json`);
      writeBundleJson(bundle, p);
      written.push(p);
    }
    if (tokens.has('sqlite')) {
      const p = join(dir, `${base}.sqlite`);
      writeBundleSqlite(bundle, p);
      written.push(p);
    }

    const factCount = Object.values(bundle.facts.scopes).reduce((s: number, l: any) => s + (Array.isArray(l) ? l.length : 0), 0);
    const vecCount = Object.values(bundle.vectors.vectors).reduce((s: number, l: any) => s + (Array.isArray(l) ? l.length : 0), 0);
    const counts = [
      `短期记忆 ${Object.keys(bundle.memory.store).length} scope`,
      `笔记 ${Object.keys(bundle.memory.notes).length}`,
      `事实 ${factCount} 条`,
      `向量 ${vecCount}`,
      `知识 ${bundle.knowledge.entries.length} 条`,
      `反思 ${bundle.reflection.reflections.length} / 规则 ${bundle.reflection.rules.length}`,
      `人格 ${Object.keys(bundle.persona.personas).length} 用户`,
      `档案 ${Object.keys(bundle.profiles).length} 用户`,
    ].join(' | ');

    return {
      text: `记忆导出完成（${scope ? 'scope=' + scope : '全部'}，格式 ${[...tokens].join('+')}）\n${counts}\n文件：\n` + written.map((w) => '- ' + w).join('\n'),
    };
  }

  /**
   * 把导出的记忆文件(.json 或 .sqlite)迁移/恢复进当前记忆库。
   * 与导出共用同一规范:解析为同一 bundle 后再写回当前后端(json/sqlite 均可)。
   * 为安全起见:先暂停自动捕获、flush 旧的在内存 stores(持久化待写+清旧定时器),
   * 合并写入后端后再重建内存实例,使本次导入立即生效。
   */
  private async importBundle(filePath: string, mode: ImportMode): Promise<{ text: string }> {
    const backend = this.backend!;
    let result: ReadBundleResult;
    try {
      result = readBundleFromFile(filePath);
    } catch (e: any) {
      return { text: `⚠ 导入失败: ${e?.message ?? e}` };
    }
    const { bundle, source } = result;

    // 暂停自动捕获,避免与导入并发写盘
    const wasCapturing = !!this.captureTimer;
    if (this.captureTimer) { clearInterval(this.captureTimer); this.captureTimer = null; }

    // flush 旧的在内存 stores:持久化未落盘编辑,并清掉各自定时器
    this.mem?.flush();
    this.vectors?.flush();
    this.facts?.flush();
    this.kb?.flush();
    this.reflect?.flush();
    this.persona?.flush();
    this.profile?.flush();

    // 合并写入当前后端(json/sqlite 皆可)
    const summary = applyBundle(backend, bundle, mode);

    // 重建内存实例 —— 立刻读到导入后的数据
    this.reloadStores();

    // 恢复自动捕获
    if (wasCapturing) this.startCapture();

    // 让记忆快照立即反映导入后的内容
    void this.pushContextSnapshot();

    const scopes = summary.importedScopes.length ? summary.importedScopes.join(', ') : '（无 scope 键）';
    return {
      text:
        `记忆导入完成（来源: ${source}，模式: ${mode}）\n` +
        `写入存储段: ${summary.stems.join(', ')}\n` +
        `涉及 scope: ${scopes}\n` +
        `导出包信息: spec=${bundle.specVersion}, 时间=${bundle.exportedAt}, 原始作用域=${bundle.scope}, 原始后端=${bundle.backend}`,
    };
  }

  /** 重建全部内存 store 实例(从当前后端重新加载),使导入/迁移立即生效。 */
  private reloadStores(): void {
    const dataDir = this.dataDir;
    this.mem = new MemoryBase(dataDir, this.cfg.maxHistory, this.backend!);
    this.vectors = new VectorStore(dataDir, this.backend!);
    this.facts = new FactStore(dataDir, this.backend!);
    this.kb = new KnowledgeStore(dataDir, this.backend!);
    this.reflect = new ReflectionStore(dataDir, this.backend!);
    this.persona = new PersonaStore(dataDir, this.backend!);
    this.profile = new ProfileStore(dataDir, this.backend!);
    // 内容已变,让下一次快照无条件重推(旧的未投递快照会被撤回)
    this.snapshot?.invalidate();
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
      // 事实库先去重(返回新增条数)。已存在则跳过 embed 与向量写入(B1:重复事件不再重复烧 embed 窗口)。
      const added = this.facts!.add(scope, [text]);
      if (!added) continue;
      const vec = this.cfg.embeddingProvider === 'off' ? null : await this.embedder!.embed(text);
      this.vectors!.add(scope, text, vec, this.cfg.maxVectorsPerScope);
      captured++; // 仅统计「本次实际新增的向量」(之前虚报为事件数)
    }
    this.lastCursor = to;
    if (captured > 0) { this.facts!.flush(); this.vectors!.flush(); }
    return captured;
  }

  /**
   * 后台补索引(0.2.5,B2):扫描历史 `vector:null` 的条目并补 embed。
   * embeddingProvider 从 off 切到 on 后,off 期间产生的记录(反馈里的 723/1834)永远不会被建索引——
   * 此任务在宿主空闲时低频补建,使其逐步可参与向量召回。
   * 返回本轮实际补建的条数;限流(默认每轮 20)以压住本地 Ollama。
   */
  private async backfillVectors(limitPerRound = 20): Promise<number> {
    const host = this.host;
    if (!host || !this.vectors || !this.embedder) return 0;
    if (this.cfg.embeddingProvider === 'off') return 0; // 向量关闭则不补
    if (host.isPaused?.() === true) return 0; // 宿主暂停时不抢资源
    const pending = this.vectors.pendingVectors(limitPerRound);
    if (!pending.length) return 0;
    let done = 0;
    for (const p of pending) {
      try {
        const vec = await this.embedder.embed(p.text);
        if (vec && vec.length) { this.vectors.setVector(p.scope, p.index, vec); done++; }
      } catch {
        /* 单条失败不中断整轮,下一轮再试 */
      }
    }
    if (done) this.vectors.flush();
    return done;
  }

  private view() {
    return buildView(this.mem!, this.vectors!, 'main', this.cfg.notesInPrompt, this.profile);
  }

  private async push(type: string, text: string): Promise<EventEnvelope | null> {
    if (!this.host) return null;
    this.seq += 1;
    // 内部事件+piggyback:记忆快照进会话历史但不唤醒回合,否则每个周期会触发生成让 bot 自言自语。
    try {
      return await this.host.pushEvent({
        type,
        ts: new Date().toISOString(),
        source: this.id,
        origin: 'internal',
        text,
      }, { trigger: 'piggyback' });
    } catch {
      return null;
    }
  }

  /** 记忆快照的语义指纹:只认会改变「她记得什么」的字段,忽略条数等易变统计。 */
  private contextSignature(): string {
    return snapshotSignature(this.view());
  }

  /**
   * 推一条记忆快照(piggyback 内部事件)。
   * 去重与「撤回上一条未投递快照」的策略在 SnapshotPusher 里(有单测),这里只负责装配。
   */
  private async pushContextSnapshot(force = false): Promise<void> {
    if (!this.host || !this.mem || !this.vectors) return;
    if (!this.snapshot) {
      const host = this.host;
      this.snapshot = new SnapshotPusher({
        push: async (text) => (await this.push('memory.context', text))?.cursor ?? null,
        withdraw: async (cursor) => {
          try { return (await host.withdrawPending?.(cursor)) === true; } catch { return false; }
        },
      });
    }
    await this.snapshot.maybePush(this.contextSignature(), buildEventText(this.view()), force);
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
          // 仅当事实库实际新增时才建向量(B1:重复记忆不再重复 embed/写向量);VectorStore.add 自身也有去重兜底。
          if (added) {
            this.vectors!.add(scope, text, this.cfg.embeddingProvider === 'off' ? null : await this.embedder!.embed(text), this.cfg.maxVectorsPerScope);
          }
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
          const items: string[] = [];
          const seen = new Set<string>();
          for (const f of facts) if (!seen.has(f.text)) { seen.add(f.text); items.push(f.text); }
          for (const h of hits) if (!seen.has(h.text)) { seen.add(h.text); items.push(h.text); }
          if (!items.length) return `OK ${global ? '全部域' : scope} 里没有匹配「${query}」的记忆`;
          // 长度封顶:单条与总量都受限,避免超长记忆(尤其自动捕获的整段聊天)打爆上下文。
          const fmt = formatRecallResults(items, { maxItems: topK });
          const head = fmt.shown < fmt.total ? `（命中 ${fmt.total} 条，按长度上限显示前 ${fmt.shown} 条）\n` : '';
          return `OK ${head}${fmt.body}`;
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
      mem_backfill: mk('mem_backfill', '后台补索引:把历史「无向量」的记忆条目(embeddingProvider=off 期间或 0.2.5 之前产生的)逐步补建向量索引,使其能参与语义召回。返回本轮实际补建的条数。可手动多跑几轮加速历史补建。', { limit: num('本轮上限(默认20,最多100)') }, [], ['act'],
        async (a) => {
          const n = await this.backfillVectors(Math.min(100, Number(a.limit) || 20));
          return n ? `OK 本轮补建 ${n} 条向量索引` : 'OK 没有待补建的索引(或向量已关闭)';
        }),
      mem_flush: mk('mem_flush', '把记忆立即落盘(平时自动防抖落盘,一般不用调)。', {}, [], ['act'],
        async () => { this.mem?.flush(); this.vectors?.flush(); this.facts?.flush(); this.kb?.flush(); this.reflect?.flush(); this.persona?.flush(); this.profile?.flush(); return 'OK 已落盘'; }),
      mem_export: mk(
        'mem_export',
        '把全部记忆导出为文件,便于备份/迁移/阅读。导出与迁入共用同一套 cortico-memory-export 规范,json 与 sqlite 可互换。知识库为全局始终包含;其他可按作用域/用户过滤。',
        {
          format: { type: 'string', optional: true, title: '格式', description: "json | markdown | sqlite | both(json+md) | all(三者),或用逗号/竖线组合;默认 both。" },
          scope: { type: 'string', optional: true, title: '作用域过滤', description: '可选,按作用域/用户过滤(短期/事实/向量按 scope;反思/人格/档案按 userId)。留空导出全部。' },
          outDir: { type: 'string', optional: true, title: '导出目录', description: '可选,文件保存目录,默认 <数据目录>/exports。' },
        },
        [],
        ['act'],
        async (args: _Dict) => {
          const format = typeof args.format === 'string' ? args.format.trim().toLowerCase() : 'both';
          const scope = typeof args.scope === 'string' ? args.scope.trim() : '';
          const outDir = typeof args.outDir === 'string' ? args.outDir.trim() : '';
          return await this.exportMemory(format, scope, outDir);
        },
      ),
      mem_import: mk(
        'mem_import',
        '把导出的记忆文件(.json 或 .sqlite,遵循 cortico-memory-export 规范)迁移/恢复进当前记忆库。导出与迁入使用同一套规范,两种格式可互换。默认 merge(按 scope/userId 合并、数组去重);可选 replace 覆盖数组型内容(向量/知识/反思/笔记等)。',
        {
          path: { type: 'string', title: '文件路径', description: '.json 或 .sqlite 记忆导出文件(绝对或相对路径)。' },
          mode: { type: 'string', optional: true, title: '合并模式', description: "merge(默认) | replace。merge 按作用域/用户合并并对数组去重;replace 覆盖数组型内容。" },
        },
        ['path'],
        ['write', 'act'],
        async (args: _Dict) => {
          const p = typeof args.path === 'string' ? args.path.trim() : '';
          if (!p) return { text: '错误：必须提供 path(导出文件路径)。' };
          const mode: ImportMode = args.mode === 'replace' ? 'replace' : 'merge';
          return await this.importBundle(p, mode);
        },
      ),
    };
  }
}
