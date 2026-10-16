/**
 * 三级记忆底座 —— 移植自 E:/qq_bot/memory.py 的 `Memory` 类,qq_bot 源码零改动。
 *
 * 对齐项:
 *  - 短期:每 scope 保留最近 maxHistory 条原始对话(cap 环形语义);
 *  - 摘要:超窗口旧历史压缩后的长期保留(这里提供存取,压缩本身由人格用工具完成);
 *  - 话题:当前话题串,供话题切换检测;
 *  - 持久化:JSON 落盘 + 2 秒防抖合并写 + close() 强制刷盘(对齐 atexit 语义);
 *  - overflow_items:取前一半旧条目出窗(与 python 版同一半数保留策略)。
 * 差异:qq_bot 按 `user:{id}` 统一键;Cortico 侧没有 IM 用户概念,scope 由调用方给
 * (默认 'main',可按渠道/世界分域,如 'mc'、'qq:21907')。
 */
import { StoreBackend, JsonBackend } from './backend.ts';

export interface ShortTermEntry {
  role: 'user' | 'assistant' | 'system';
  content: string;
  ts: number;
}

const SAVE_DEBOUNCE_MS = 2000;

export class MemoryBase {
  private readonly store = new Map<string, ShortTermEntry[]>();
  private readonly summary = new Map<string, string>();
  private readonly topic = new Map<string, string>();
  private readonly notes = new Map<string, Array<{ text: string; ts: number }>>();
  private readonly stem = 'memory-data';
  private readonly backend: StoreBackend;
  private dirty = false;
  private lastSave = 0;
  private flushTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(
    dataDir: string,
    private readonly maxHistory: number,
    backend?: StoreBackend,
  ) {
    this.backend = backend ?? new JsonBackend(dataDir);
    this.load();
  }

  // ---------------- 持久化(防抖,对齐 _SAVE_DEBOUNCE) ----------------
  private load(): void {
    const raw = this.backend.readJson(this.stem);
    if (!raw) return;
    try {
      const r = raw as {
        store?: Record<string, ShortTermEntry[]>;
        summary?: Record<string, string>;
        topic?: Record<string, string>;
        notes?: Record<string, Array<{ text: string; ts: number }>>;
      };
      for (const [k, v] of Object.entries(raw.store ?? {})) if (Array.isArray(v)) this.store.set(k, v.slice(-this.maxHistory));
      for (const [k, v] of Object.entries(raw.summary ?? {})) if (typeof v === 'string') this.summary.set(k, v);
      for (const [k, v] of Object.entries(raw.topic ?? {})) if (typeof v === 'string') this.topic.set(k, v);
      for (const [k, v] of Object.entries(r.notes ?? {})) if (Array.isArray(v)) this.notes.set(k, v);
    } catch { /* 损坏按空起步 */ }
  }

  private scheduleSave(): void {
    const now = Date.now();
    if (now - this.lastSave < SAVE_DEBOUNCE_MS) {
      this.dirty = true;
      if (!this.flushTimer) {
        this.flushTimer = setTimeout(() => { this.flushTimer = null; this.flush(); }, SAVE_DEBOUNCE_MS);
        this.flushTimer.unref?.();
      }
      return;
    }
    this.flush();
  }

  /** 全量落盘(防抖到期 / stop 时 / mem_flush 工具都会调)。 */
  flush(): void {
    try {
      const dump = (m: Map<string, unknown>) => Object.fromEntries([...m.entries()].filter(([, v]) => Array.isArray(v) ? (v as unknown[]).length : !!v));
      const data = {
        store: dump(this.store) as Record<string, ShortTermEntry[]>,
        summary: dump(this.summary) as Record<string, string>,
        topic: dump(this.topic) as Record<string, string>,
        notes: dump(this.notes) as Record<string, Array<{ text: string; ts: number }>>,
      };
      this.backend.writeJson(this.stem, data);
      this.dirty = false;
      this.lastSave = Date.now();
    } catch { /* 磁盘失败不炸主流程 */ }
  }

  // ---------------- 短期 ----------------
  add(scope: string, role: ShortTermEntry['role'], content: string): void {
    const s = scope || 'main';
    const list = (this.store.get(s) ?? []).slice();
    list.push({ role, content, ts: Date.now() });
    this.store.set(s, list.slice(-this.maxHistory));
    this.scheduleSave();
  }

  recent(scope: string, n?: number): ShortTermEntry[] {
    const list = this.store.get(scope || 'main') ?? [];
    return n && n > 0 ? list.slice(-n) : [...list];
  }

  /** 短期是否已满(对齐 is_full)。 */
  isFull(scope: string): boolean {
    return (this.store.get(scope || 'main')?.length ?? 0) >= this.maxHistory;
  }

  /**
   * 取出需要压缩进摘要的旧条目(前一半),短期保留后一半。对齐 overflow_items。
   * 返回 null = 还没满到该压缩。
   */
  overflowItems(scope: string): ShortTermEntry[] | null {
    const s = scope || 'main';
    const items = this.store.get(s) ?? [];
    if (items.length <= this.maxHistory / 2) return null;
    const overflow = items.slice(0, items.length - Math.floor(this.maxHistory / 2));
    this.store.set(s, items.slice(items.length - Math.floor(this.maxHistory / 2)));
    this.scheduleSave();
    return overflow;
  }

  clearShortTerm(scope: string): void {
    this.store.delete(scope || 'main');
    this.scheduleSave();
  }

  // ---------------- 摘要 / 话题 ----------------
  setSummary(scope: string, text: string): void {
    if (text.trim()) this.summary.set(scope || 'main', text.trim());
    else this.summary.delete(scope || 'main');
    this.scheduleSave();
  }

  getSummary(scope: string): string {
    return this.summary.get(scope || 'main') ?? '';
  }

  setTopic(scope: string, text: string): void {
    if (text.trim()) this.topic.set(scope || 'main', text.trim());
    else this.topic.delete(scope || 'main');
    this.scheduleSave();
  }

  getTopic(scope: string): string {
    return this.topic.get(scope || 'main') ?? '';
  }

  // ---------------- 重要信息(对齐 important_notes 的存取语义) ----------------
  addNote(scope: string, text: string): number {
    const s = scope || 'main';
    const list = this.notes.get(s) ?? [];
    list.push({ text: text.trim(), ts: Date.now() });
    this.notes.set(s, list.slice(-100));
    this.scheduleSave();
    return list.length - 1; // 返回新笔记的 0-based 索引（与 mem_forget_note 对齐）
  }

  getNotes(scope: string): Array<{ text: string; ts: number }> {
    return this.notes.get(scope || 'main') ?? [];
  }

  removeNote(scope: string, index: number): boolean {
    const list = this.notes.get(scope || 'main') ?? [];
    if (index < 0 || index >= list.length) return false;
    list.splice(index, 1);
    this.notes.set(scope || 'main', list);
    this.scheduleSave();
    return true;
  }

  // ---------------- 全局 ----------------
  scopes(): string[] {
    const set = new Set<string>([...this.store.keys(), ...this.summary.keys(), ...this.topic.keys(), ...this.notes.keys()]);
    return [...set].sort();
  }
}
