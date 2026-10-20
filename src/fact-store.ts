import { createHash } from 'node:crypto';
import { StoreBackend, JsonBackend } from './backend.ts';

export interface Fact {
  hash: string;
  text: string;
  confidence: number;
  createdAt: number;
  updatedAt: number;
}

/** 单条事实落盘前的最大长度(超长截断,与召回端 RECALL_ITEM_MAX 形成双截断兜底)。 */
export const FACT_TEXT_MAX = 2000;

/**
 * 独立事实库(对齐 qq_bot fact_store 的行为):
 * - per-scope 隔离(user_id 等价)
 * - SHA-256 去重(INSERT OR IGNORE, hash = sha256(`${scope}:${text}`))
 * - 原子落盘(临时文件 + rename,同卷 rename 原子,等价于 fact_store 的 archive-first)
 * - 全文/词频检索(对齐 qq_bot FTS5 全文召回的语义)
 *
 * 纯 JS 实现,不引入 better-sqlite3 原生依赖(world 扩展装原生模块有风险)。
 */
export class FactStore {
  private readonly stem = 'fact-store';
  private readonly backend: StoreBackend;
  private data: Record<string, Fact[]> = {};
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
      if (raw && typeof raw === 'object' && (raw as { scopes?: unknown }).scopes) {
        this.data = (raw as { scopes: Record<string, Fact[]> }).scopes;
      }
    } catch {
      this.data = {};
    }
  }

  private saveNow(): void {
    if (!this.dirty) return;
    this.backend.writeJson(this.stem, { scopes: this.data });
    this.dirty = false;
  }

  /** 强制落盘(供 stop 调用)。 */
  flush(): void {
    clearInterval(this.flushTimer);
    this.saveNow();
  }

  private hash(scope: string, text: string): string {
    return createHash('sha256').update(`${scope}:${text}`).digest('hex');
  }

  /** 写入事实;返回新写入条数(已存在的重复事实跳过)。 */
  add(scope: string, texts: string[]): number {
    let added = 0;
    const list = this.data[scope] ?? (this.data[scope] = []);
    const now = Date.now() / 1000;
    for (const t of texts) {
      let text = (t ?? '').toString().trim();
      if (!text) continue;
      if (text.length > FACT_TEXT_MAX) text = text.slice(0, FACT_TEXT_MAX);
      const h = this.hash(scope, text);
      if (list.some((f) => f.hash === h)) continue; // 去重
      list.push({ hash: h, text, confidence: 1.0, createdAt: now, updatedAt: now });
      added++;
    }
    if (added) this.dirty = true;
    return added;
  }

  /** 取某 scope 全部事实(按 updatedAt 倒序)。 */
  get(scope: string): Fact[] {
    return (this.data[scope] ?? []).slice().sort((a, b) => b.updatedAt - a.updatedAt);
  }

  /** 全文/词频召回(对齐 qq_bot recall_facts 的语义)。 */
  recall(scope: string, query: string, limit = 5): Fact[] {
    const q = query.trim().toLowerCase();
    const list = this.data[scope] ?? [];
    if (!q) return list.slice(0, Math.max(1, limit));
    const terms = q.split(/\s+/).filter(Boolean);
    return list
      .map((f) => {
        const text = f.text.toLowerCase();
        let score = 0;
        for (const term of terms) if (text.includes(term)) score += 1;
        return { f, score };
      })
      .filter((x) => x.score > 0)
      .sort((a, b) => b.score - a.score)
      .slice(0, Math.max(1, limit))
      .map((x) => x.f);
  }

  /** 总条数(scope 省略则全部)。 */
  count(scope?: string): number {
    if (!scope) return Object.values(this.data).reduce((s, l) => s + l.length, 0);
    return (this.data[scope] ?? []).length;
  }

  /**
   * 跨 scope 召回:扫描全部 scope 的事实,按词频打分、按 hash 去重、取 top_k。
   * 用于「自动捕获的对话」与显式事实共存的场景——scope 留空时也能搜到对话域。
   */
  recallAll(query: string, limit = 5): Fact[] {
    const q = query.trim().toLowerCase();
    if (!q) return [];
    const terms = q.split(/\s+/).filter(Boolean);
    const scored: Array<{ f: Fact; score: number }> = [];
    for (const list of Object.values(this.data)) {
      for (const f of list) {
        const text = f.text.toLowerCase();
        let score = 0;
        for (const term of terms) if (text.includes(term)) score += 1;
        if (score > 0) scored.push({ f, score });
      }
    }
    // 同一事实可能命中多 scope(文本相同 hash 不同),按 hash 去重保留最高分
    const best = new Map<string, { f: Fact; score: number }>();
    for (const x of scored) {
      const cur = best.get(x.f.hash);
      if (!cur || x.score > cur.score) best.set(x.f.hash, x);
    }
    return [...best.values()]
      .sort((a, b) => b.score - a.score)
      .slice(0, Math.max(1, limit))
      .map((x) => x.f);
  }
}
