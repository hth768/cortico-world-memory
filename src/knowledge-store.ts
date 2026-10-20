import { StoreBackend, JsonBackend } from './backend.ts';

export interface KnowledgeEntry {
  id: string;
  topic: string;
  keywords: string[];
  facts: string[];
  sources: string[];
  learnedAt: string;
  updated: string;
  hits: number;
}

interface KbFile {
  entries: KnowledgeEntry[];
}

const MAX_ENTRIES = 200;
const MAX_FACTS_PER_ENTRY = 20;
const MAX_KEYWORDS = 12;
const MAX_SOURCES = 8;

const norm = (s: string): string => (s ?? '').replace(/\s+/g, '').toLowerCase();
// 召回匹配域:主题 + 关键词 + 事实全文(否则中文事实只在 fact 文本里、关键词里没有,会检索不到)。
const entryBlob = (e: KnowledgeEntry): string => [e.topic, ...e.keywords, ...e.facts].join(' ').toLowerCase();
const queryTokens = (q: string): string[] =>
  (q.toLowerCase().match(/[a-z0-9][a-z0-9.\-_/#]*/g) ?? []).filter((t) => t.length >= 2);

/**
 * 通用知识库(对齐 qq_bot knowledge_store):
 * - 联网学到的通用知识沉淀于此(与 fact_store 事实库区分:这里是「主题化知识条目」)
 * - add:同主题合并、事实级全库去重、超量淘汰最旧
 * - recall:主题/关键词命中 + 全 token 命中,复用知识省去重复搜索
 * - 原子落盘(临时文件 + rename)
 */
export class KnowledgeStore {
  private readonly stem = 'knowledge-base';
  private readonly backend: StoreBackend;
  private data: KbFile = { entries: [] };
  private dirty = false;
  private readonly flushTimer: ReturnType<typeof setInterval>;

  constructor(dataDir: string, backend?: StoreBackend, flushMs = 2000) {
    this.backend = backend ?? new JsonBackend(dataDir);
    this.load();
    this.flushTimer = setInterval(() => this.flush(), flushMs);
  }

  private load(): void {
    try {
      const raw = this.backend.readJson(this.stem);
      if (raw && Array.isArray((raw as KbFile).entries)) this.data.entries = (raw as KbFile).entries;
    } catch {
      this.data = { entries: [] };
    }
  }

  private saveNow(): void {
    if (!this.dirty) return;
    this.backend.writeJson(this.stem, this.data);
    this.dirty = false;
  }

  flush(): void {
    clearInterval(this.flushTimer);
    this.saveNow();
  }

  /** 添加/合并一条知识(对应 add_entry):主题合并 + 事实级去重 + 超量淘汰最旧。 */
  addEntry(topic: string, facts: string[], keywords: string[] = [], sources: string[] = []): { ok: boolean; newFacts: number; merged: boolean; total: number } {
    const t = (topic ?? '').trim();
    const fs = [...new Set((facts ?? []).map((f) => (f ?? '').trim()).filter(Boolean))];
    const kws = [...new Set((keywords ?? []).map((k) => (k ?? '').trim()).filter(Boolean))];
    const srcs = [...new Set((sources ?? []).map((s) => (s ?? '').trim()).filter(Boolean))];
    if (!t || !fs.length) return { ok: false, newFacts: 0, merged: false, total: this.data.entries.length };

    const now = new Date().toISOString().slice(0, 19).replace('T', ' ');
    const date = now.slice(0, 10);
    const knownFacts = new Set(this.data.entries.flatMap((e) => e.facts.map(norm)));
    const newFacts = fs.filter((f) => !knownFacts.has(norm(f)));

    const target = this.data.entries.find((e) => norm(e.topic) === norm(t)) ?? null;
    const merged = target !== null;
    if (!target) {
      const entry: KnowledgeEntry = {
        id: Math.random().toString(36).slice(2, 10),
        topic: t,
        keywords: [],
        facts: [],
        sources: [],
        learnedAt: date,
        updated: now,
        hits: 0,
      };
      this.data.entries.push(entry);
      var tgt = entry;
    } else {
      var tgt = target;
    }

    if (newFacts.length) {
      tgt.facts = [...tgt.facts, ...newFacts].slice(-MAX_FACTS_PER_ENTRY);
      tgt.updated = now;
    }
    const existKw = new Set(tgt.keywords.map((k) => k.toLowerCase()));
    for (const k of kws) if (!existKw.has(k.toLowerCase())) { tgt.keywords.push(k); existKw.add(k.toLowerCase()); }
    tgt.keywords = tgt.keywords.slice(0, MAX_KEYWORDS);
    const existSrc = new Set(tgt.sources);
    for (const s of srcs) if (!existSrc.has(s)) { tgt.sources.push(s); existSrc.add(s); }
    tgt.sources = tgt.sources.slice(0, MAX_SOURCES);

    if (this.data.entries.length > MAX_ENTRIES) {
      this.data.entries.sort((a, b) => a.updated.localeCompare(b.updated));
      this.data.entries = this.data.entries.slice(-MAX_ENTRIES);
    }
    this.dirty = true;
    return { ok: true, newFacts: newFacts.length, merged, total: this.data.entries.length };
  }

  /** 单条文本入知识库(对应 add_fact):主题取前 30 字,关键词取英文/数字词。 */
  addFact(content: string): { ok: boolean; newFacts: number; merged: boolean; total: number } {
    const c = (content ?? '').trim();
    if (!c) return { ok: false, newFacts: 0, merged: false, total: this.data.entries.length };
    const tokens = [...new Set(c.toLowerCase().match(/[a-z0-9][a-z0-9.\-_/#]*/g) ?? [])].slice(0, 6);
    return this.addEntry(c.slice(0, 30).trim(), [c], tokens, []);
  }

  /** 检索知识(对应 build_recall_context 的检索部分)。 */
  recall(query: string, limit = 2): KnowledgeEntry[] {
    const q = (query ?? '').trim().toLowerCase();
    if (!q) return [];
    const qTokens = queryTokens(query);
    const scored: { e: KnowledgeEntry; score: number }[] = [];
    for (const e of this.data.entries) {
      let score = 0;
      for (const kw of [e.topic, ...e.keywords]) {
        const k = kw.trim().toLowerCase();
        // 放宽阈值(中文 2 字词即有效);双向子串匹配(适配中文查询/关键词长度不对称)。
        if (k.length >= 2 && (q.includes(k) || k.includes(q))) score = Math.max(score, k === e.topic.toLowerCase() ? 3 : 2);
      }
      // 事实文本命中(中文/长句常只在 fact 里):双向子串给基础分 1。
      if (score === 0) {
        for (const f of e.facts) {
          const fk = f.trim().toLowerCase();
          if (fk && (q.includes(fk) || fk.includes(q))) { score = 1; break; }
        }
      }
      if (score === 0 && qTokens.length && qTokens.every((t) => entryBlob(e).includes(t))) score = 1;
      if (score > 0) scored.push({ e, score });
    }
    scored.sort((a, b) => b.score - a.score || b.e.hits - a.e.hits);
    const hits = scored.slice(0, Math.max(1, limit)).map((x) => x.e);
    for (const h of hits) h.hits += 1; // 命中累加(对齐 mark_used)
    this.dirty = true;
    return hits;
  }

  count(): number {
    return this.data.entries.length;
  }
}
