import { StoreBackend, JsonBackend } from './backend.ts';

export type ReflectionType = 'preference' | 'style' | 'insight' | 'correction' | 'pattern';

export interface Reflection {
  type: ReflectionType;
  userId: string;
  content: string;
  evidence?: string;
  confidence: number;
  actionable: boolean;
  createdAt: number;
}

export interface InteractionRule {
  rule: string;
  type: ReflectionType;
  userId: string;
  confidence: number;
  createdAt: number;
  lastSeen: number;
}

interface ReflectFile {
  reflections: Reflection[];
  interactionRules: InteractionRule[];
  stats: { totalConversations: number; totalReflections: number; lastReflectionTs: number };
}

const MAX_REFLECTIONS = 100;
const MAX_RULES = 50;

/**
 * 反思记忆(对齐 qq_bot reflection_memory,五维记忆第四维):
 * - reflections:自我反思/交互偏好/纠错(去重:同类型+同用户+前50字相似不重复)
 * - interactionRules:从可执行的反思提炼出的可复用交互规则(置信度累加,上限50按置信度淘汰)
 * - 原子落盘(临时文件 + rename)
 */
export class ReflectionStore {
  private readonly stem = 'reflection-data';
  private readonly backend: StoreBackend;
  private data: ReflectFile = { reflections: [], interactionRules: [], stats: { totalConversations: 0, totalReflections: 0, lastReflectionTs: 0 } };
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
        const r = raw as Partial<ReflectFile>;
        this.data.reflections = Array.isArray(r.reflections) ? r.reflections : [];
        this.data.interactionRules = Array.isArray(r.interactionRules) ? r.interactionRules : [];
        if (r.stats) this.data.stats = r.stats;
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

  private addReflection(r: Reflection): boolean {
    for (const e of this.data.reflections) {
      if (e.type === r.type && e.userId === r.userId && (e.content ?? '').slice(0, 50) === (r.content ?? '').slice(0, 50)) return false; // 去重
    }
    this.data.reflections.push(r);
    if (this.data.reflections.length > MAX_REFLECTIONS) this.data.reflections = this.data.reflections.slice(-MAX_REFLECTIONS);
    this.data.stats.totalReflections += 1;
    this.data.stats.lastReflectionTs = r.createdAt;
    this.dirty = true;
    return true;
  }

  private addRule(rule: InteractionRule): void {
    for (const e of this.data.interactionRules) {
      if ((e.rule ?? '').slice(0, 50) === (rule.rule ?? '').slice(0, 50)) {
        e.confidence = Math.min((e.confidence ?? 0.5) + 0.1, 1.0); // 累加置信度
        e.lastSeen = rule.lastSeen;
        this.dirty = true;
        return;
      }
    }
    this.data.interactionRules.push(rule);
    if (this.data.interactionRules.length > MAX_RULES) {
      this.data.interactionRules.sort((a, b) => (b.confidence ?? 0) - (a.confidence ?? 0));
      this.data.interactionRules = this.data.interactionRules.slice(0, MAX_RULES);
    }
    this.dirty = true;
  }

  /** 手动沉淀一条反思(对应 mem_reflect 工具)。 */
  reflect(content: string, type: ReflectionType, userId: string, evidence?: string, confidence = 0.6, actionable = true): { added: boolean } {
    const now = Date.now() / 1000;
    const r: Reflection = { type, userId: String(userId), content: (content ?? '').trim(), evidence: evidence?.trim(), confidence, actionable, createdAt: now };
    if (!r.content) return { added: false };
    const added = this.addReflection(r); // 去重命中则返回 false(让工具如实报「重复」)
    if (added && actionable && confidence >= 0.6) {
      this.addRule({ rule: r.content, type, userId: r.userId, confidence, createdAt: now, lastSeen: now });
    }
    return { added };
  }

  /** 批量写入(供自动反思流程调用)。 */
  ingest(reflections: Reflection[]): number {
    let n = 0;
    for (const r of reflections) {
      const before = this.data.reflections.length;
      this.addReflection(r);
      if (this.data.reflections.length > before) n++;
      if (r.actionable && (r.confidence ?? 0) >= 0.6) {
        this.addRule({ rule: r.content, type: r.type, userId: r.userId, confidence: r.confidence, createdAt: r.createdAt, lastSeen: r.createdAt });
      }
    }
    return n;
  }

  /** 取某用户相关的反思 + 交互规则(供召回/注入)。 */
  getFor(userId: string): { reflections: Reflection[]; rules: InteractionRule[] } {
    const uid = String(userId);
    return {
      reflections: this.data.reflections.filter((r) => r.userId === uid),
      rules: this.data.interactionRules.filter((r) => r.userId === uid),
    };
  }

  count(): { reflections: number; rules: number } {
    return { reflections: this.data.reflections.length, rules: this.data.interactionRules.length };
  }
}
