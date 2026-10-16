import { StoreBackend, JsonBackend } from './backend.ts';

interface Profile {
  facts: string[];
  updated: number;
}

interface ProfileFile {
  profiles: Record<string, Profile>;
}

const MAX_FACTS_PER_USER = 50;

/**
 * 人物档案(对齐 qq_bot long_term_memory 的 profile 部分):
 * - 永久记住用户关键信息(称呼/身份/关系等),常驻进环境提示词
 * - update:合并新事实+去重+上限50(对齐 update_profile)
 * - replace:整体替换(用于纠错,对齐 replace_profile)
 * - 原子落盘(临时文件 + rename)
 */
export class ProfileStore {
  private readonly stem = 'user-profiles';
  private readonly backend: StoreBackend;
  private data: ProfileFile = { profiles: {} };
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
      if (raw && typeof raw === 'object' && (raw as ProfileFile).profiles) {
        this.data.profiles = (raw as ProfileFile).profiles;
      }
    } catch {
      this.data = { profiles: {} };
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

  /** 合并新事实(去重 + 上限50)。 */
  update(userId: string, facts: string[]): { total: number } {
    const uid = String(userId);
    const p = this.data.profiles[uid] ?? (this.data.profiles[uid] = { facts: [], updated: 0 });
    const existing = new Set(p.facts);
    for (const f of facts.map((x) => (x ?? '').trim()).filter(Boolean)) {
      if (!existing.has(f)) existing.add(f);
    }
    let list = [...existing];
    if (list.length > MAX_FACTS_PER_USER) list = list.slice(-MAX_FACTS_PER_USER);
    p.facts = list;
    p.updated = Date.now() / 1000;
    this.dirty = true;
    return { total: list.length };
  }

  /** 整体替换(纠错,对齐 replace_profile)。 */
  replace(userId: string, facts: string[]): { total: number } {
    const uid = String(userId);
    const list = [...new Set(facts.map((x) => (x ?? '').trim()).filter(Boolean))].slice(-MAX_FACTS_PER_USER);
    this.data.profiles[uid] = { facts: list, updated: Date.now() / 1000 };
    this.dirty = true;
    return { total: list.length };
  }

  get(userId: string): string[] {
    return this.data.profiles[String(userId)]?.facts ?? [];
  }

  /** 生成注入提示词用的文本(对齐 build_profile_hint)。 */
  hint(userId: string): string {
    const facts = this.get(userId);
    if (!facts.length) return '';
    return `人物档案(${userId}):\n` + facts.map((f, i) => `${i + 1}. ${f}`).join('\n');
  }

  count(): number {
    return Object.keys(this.data.profiles).length;
  }
}
