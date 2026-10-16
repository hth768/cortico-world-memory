/**
 * 存储后端抽象 —— 让 7 个记忆 store 的落盘方式可在「JSON 文件」与「SQLite」间切换,
 * store 内部逻辑零改动(仍是内存对象,只把 load/save 委托给 backend.readJson/writeJson)。
 *
 *  - JsonBackend(默认):保持原行为,每 stem 一个 `*.json` 文件,原子提交(tmp+rename)。
 *  - SqliteBackend:单库 `memory.db` 的 KV 表 `kv(name TEXT PRIMARY KEY, data TEXT)`,
 *    每个 stem 的完整文件对象作为一行 JSON 存储。首次启动若检测到旧 JSON 文件,
 *    自动迁移进 SQLite(一次性,不丢历史)。
 *
 *  SQLite 驱动优先级:先试 `better-sqlite3`(原生,若已安装),缺失则回退 Node 内置
 *  `node:sqlite`(v24+ 自带,零安装)。两者 API 兼容(.prepare().get()/.run()、.exec())。
 */
import { existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

export type BackendKind = 'json' | 'sqlite';

/** 全部记忆存储的 stem(文件名去掉 .json)。迁移与校验用。 */
export const ALL_STEMS = [
  'memory-data',
  'fact-store',
  'knowledge-base',
  'reflection-data',
  'persona-data',
  'user-profiles',
  'vector-memory',
] as const;

export interface StoreBackend {
  readonly kind: BackendKind;
  /** 读取某 stem 的完整文件对象;不存在或损坏返回 null。 */
  readJson(stem: string): unknown | null;
  /** 写入某 stem 的完整文件对象(原子/即时)。 */
  writeJson(stem: string, obj: unknown): void;
  /** 删除某 stem(切回 JSON 等场景用)。 */
  removeJson(stem: string): void;
  /** 强制落盘/关闭(仅由 world.stop 调一次)。 */
  flush(): void;
  /** 一次性把旧 JSON 文件导入本后端(若本 stem 尚未存在)。 */
  migrateFromJson(stems: readonly string[]): void;
}

// ---------------- JSON 后端(默认,保持原行为) ----------------
export class JsonBackend implements StoreBackend {
  readonly kind = 'json' as const;
  constructor(private readonly dataDir: string) {}
  readJson(stem: string): unknown | null {
    const f = join(this.dataDir, stem + '.json');
    if (!existsSync(f)) return null;
    try {
      return JSON.parse(readFileSync(f, 'utf8'));
    } catch {
      return null;
    }
  }
  writeJson(stem: string, obj: unknown): void {
    const f = join(this.dataDir, stem + '.json');
    try {
      mkdirSync(dirname(f), { recursive: true });
      const tmp = f + '.tmp';
      writeFileSync(tmp, JSON.stringify(obj, null, 2), 'utf8');
      renameSync(tmp, f);
    } catch {
      /* 落盘失败不影响内存态,下次 flush 重试 */
    }
  }
  removeJson(stem: string): void {
    const f = join(this.dataDir, stem + '.json');
    try {
      if (existsSync(f)) renameSync(f, f + '.bak');
    } catch {
      /* ignore */
    }
  }
  flush(): void {}
  migrateFromJson(): void {
    /* JSON 后端本就以文件为准,无需迁移 */
  }
}

// ---------------- SQLite 后端(KV 封装) ----------------
class SqliteBackend implements StoreBackend {
  readonly kind = 'sqlite' as const;
  readonly driver: string;
  private constructor(
    private readonly dataDir: string,
    private readonly db: any,
    driver: string,
  ) {
    db.exec('CREATE TABLE IF NOT EXISTS kv (name TEXT PRIMARY KEY, data TEXT)');
    this.driver = driver;
  }

  static async create(dataDir: string): Promise<SqliteBackend> {
    mkdirSync(dataDir, { recursive: true });
    let db: any;
    let driver: string;
    try {
      const mod: any = await import('better-sqlite3');
      const Database = mod.default ?? mod;
      db = new Database(join(dataDir, 'memory.db'));
      driver = 'better-sqlite3';
    } catch {
      const { DatabaseSync } = await import('node:sqlite');
      db = new DatabaseSync(join(dataDir, 'memory.db'));
      driver = 'node:sqlite';
    }
    return new SqliteBackend(dataDir, db, driver);
  }

  readJson(stem: string): unknown | null {
    const row = this.db.prepare('SELECT data FROM kv WHERE name = ?').get(stem);
    if (!row) return null;
    try {
      return JSON.parse(row.data);
    } catch {
      return null;
    }
  }

  writeJson(stem: string, obj: unknown): void {
    this.db.prepare('INSERT OR REPLACE INTO kv (name, data) VALUES (?, ?)').run(stem, JSON.stringify(obj));
  }

  removeJson(stem: string): void {
    this.db.prepare('DELETE FROM kv WHERE name = ?').run(stem);
  }

  flush(): void {
    try {
      this.db.close();
    } catch {
      /* ignore */
    }
  }

  migrateFromJson(stems: readonly string[]): void {
    for (const stem of stems) {
      if (this.readJson(stem) !== null) continue; // 已迁移过则跳过
      const f = join(this.dataDir, stem + '.json');
      if (!existsSync(f)) continue;
      try {
        this.writeJson(stem, JSON.parse(readFileSync(f, 'utf8')));
      } catch {
        /* 损坏文件忽略 */
      }
    }
  }
}

export type LogFn = (msg: string) => void;

/** 按配置创建后端。sqlite 初始化失败时回退 JSON 并打日志。 */
export async function createBackend(kind: BackendKind, dataDir: string, log?: LogFn): Promise<StoreBackend> {
  if (kind === 'sqlite') {
    try {
      const b = await SqliteBackend.create(dataDir);
      log?.(`[memory] 存储后端=sqlite (driver=${b.driver})`);
      return b;
    } catch (e: any) {
      log?.(`[memory] sqlite 初始化失败,回退 JSON: ${e?.message ?? e}`);
    }
  }
  log?.('[memory] 存储后端=json');
  return new JsonBackend(dataDir);
}

/**
 * 只读打开 memory.db,导出 KV 行为 Map<stem, obj>。供「切回 JSON」时回填用。
 * 优先 better-sqlite3,缺失则回退 Node 内置 node:sqlite(本环境走这条)。
 */
export async function readSqliteData(dataDir: string, stems: readonly string[]): Promise<Map<string, unknown>> {
  const dbFile = join(dataDir, 'memory.db');
  if (!existsSync(dbFile)) return new Map();
  let db: any;
  try {
    const mod: any = await import('better-sqlite3');
    const Database = mod.default ?? mod;
    db = new Database(dbFile, { readonly: true });
  } catch {
    const { DatabaseSync } = await import('node:sqlite');
    db = new DatabaseSync(dbFile, { readOnly: true });
  }
  const out = new Map<string, unknown>();
  try {
    let rows: any[];
    if (stems.length) {
      const ph = stems.map(() => '?').join(',');
      rows = db.prepare(`SELECT name, data FROM kv WHERE name IN (${ph})`).all(...stems);
    } else {
      rows = db.prepare('SELECT name, data FROM kv').all();
    }
    for (const r of rows) {
      try { out.set(r.name, JSON.parse(r.data)); } catch { /* 跳过损坏行 */ }
    }
  } finally {
    try { db.close(); } catch { /* ignore */ }
  }
  return out;
}

/**
 * 切回 JSON 时,若 memory.db 存在且其中数据比对应 JSON 文件更新,回填到 JSON 文件,
 * 消除 json↔sqlite 切换的数据不对称(此前 sqlite→json 会丢 SQLite 期间的写入)。
 * 返回回填的 store 数量。仅当 JSON 缺文件或比 DB 更旧时才覆盖,避免冲掉用户在 JSON 上的后续手动编辑。
 */
export async function backfillSqliteToJson(dataDir: string, log?: LogFn): Promise<number> {
  const dbFile = join(dataDir, 'memory.db');
  if (!existsSync(dbFile)) return 0;
  let fromSqlite: Map<string, unknown>;
  try {
    fromSqlite = await readSqliteData(dataDir, ALL_STEMS);
  } catch (e: any) {
    log?.(`[memory] 读 SQLite 失败,跳过回填: ${e?.message ?? e}`);
    return 0;
  }
  if (!fromSqlite.size) return 0;
  const json = new JsonBackend(dataDir);
  let filled = 0;
  const dbMtime = statSync(dbFile).mtimeMs;
  for (const stem of ALL_STEMS) {
    if (!fromSqlite.has(stem)) continue;
    const jsonFile = join(dataDir, stem + '.json');
    const jsonMtime = existsSync(jsonFile) ? statSync(jsonFile).mtimeMs : 0;
    if (jsonMtime === 0 || dbMtime > jsonMtime) {
      json.writeJson(stem, fromSqlite.get(stem));
      filled++;
    }
  }
  if (filled) log?.(`[memory] 已从 SQLite 回填 ${filled} 个 store 到 JSON(不丢切换期间写入)`);
  return filled;
}
