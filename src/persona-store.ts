import { StoreBackend, JsonBackend } from './backend.ts';

interface Persona {
  traits: string[];
  style: string;
  updated: number;
}

interface PersonaFile {
  personas: Record<string, Persona>;
  globalStyle: string;
}

const MAX_TRAITS_PER_USER = 20;

/**
 * 人格记忆(对齐 qq_bot persona_memory,五维记忆第五维):
 * - 与每个用户的独特相处模式(特征 traits + 风格 style),per-user 隔离
 * - 特征合并去重 + 上限淘汰;全局风格可选
 * - 原子落盘(临时文件 + rename)
 */
export class PersonaStore {
  private readonly stem = 'persona-data';
  private readonly backend: StoreBackend;
  private data: PersonaFile = { personas: {}, globalStyle: '' };
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
      if (raw && typeof raw === 'object') {
        const r = raw as Partial<PersonaFile>;
        this.data.personas = r.personas ?? {};
        this.data.globalStyle = r.globalStyle ?? '';
      }
    } catch {
      /* 损坏则重置 */
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

  /** 更新某用户的人格记忆(特征合并去重 + 上限)。 */
  update(userId: string, traits: string[], style = ''): { traits: number } {
    const uid = String(userId);
    const persona = this.data.personas[uid] ?? (this.data.personas[uid] = { traits: [], style: '', updated: 0 });
    const existing = new Set(persona.traits);
    for (const t of traits.map((x) => (x ?? '').trim()).filter(Boolean)) {
      if (!existing.has(t)) existing.add(t);
    }
    let list = [...existing];
    if (list.length > MAX_TRAITS_PER_USER) list = list.slice(-MAX_TRAITS_PER_USER);
    persona.traits = list;
    if (style && style.trim()) persona.style = style.trim();
    persona.updated = Date.now() / 1000;
    this.dirty = true;
    return { traits: list.length };
  }

  setGlobalStyle(style: string): void {
    this.data.globalStyle = (style ?? '').trim();
    this.dirty = true;
  }

  get(userId: string): Persona | null {
    return this.data.personas[String(userId)] ?? null;
  }

  getGlobalStyle(): string {
    return this.data.globalStyle;
  }

  count(): number {
    return Object.keys(this.data.personas).length;
  }
}
