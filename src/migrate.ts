// Memory export / import — single canonical spec shared by .json and .sqlite.
//
// Spec (cortico-memory-export, specVersion 1):
//   {
//     format, specVersion, plugin, exportedAt, scope, backend,
//     memory:    { store, summary, topic, notes },
//     facts:     { scopes: Record<scope, Fact[]> },
//     vectors:   { model: string|null, vectors: Record<scope, VectorItem[]> },
//     knowledge: { entries: KnowledgeEntry[] },
//     reflection:{ reflections, rules, stats },
//     persona:   { personas: Record<userId, Persona>, globalStyle },
//     profiles:  Record<userId, Profile>      // NOTE: the map itself, not wrapped
//   }
// Both .json and .sqlite serialise this EXACT bundle, so export->import is
// lossless and json<->sqlite are interchangeable.

import { writeFileSync, mkdirSync, existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import type { StoreBackend } from './backend.js';

export const EXPORT_FORMAT = 'cortico-memory-export';
export const EXPORT_SPEC_VERSION = 1;

type Dict<T = unknown> = Record<string, T>;

// ---- minimal structural types (kept self-contained, no cortico imports) ----
export interface Fact {
  fact: string;
  source: string;
  hash?: string;
  timestamp?: number | string;
  scope?: string;
}
export interface VectorItem {
  text: string;
  vector: string; // base64 fp16
  timestamp: number;
  scope?: string;
}
export interface KnowledgeEntry {
  id?: string;
  topic: string;
  facts: string[];
  type?: string;
  scope?: string;
  updated?: number | string;
}
export interface Reflection {
  type: string;
  content: string;
  userId?: string;
  timestamp?: number | string;
}
export interface InteractionRule {
  rule: string;
  enabled?: boolean;
  timestamp?: number | string;
}
export interface Persona {
  systemPrompt?: string;
  style?: string;
  notes?: string;
  updatedAt?: number | string;
}
export interface Profile {
  facts: string[];
  updated?: number | string;
}

export interface ExportBundle {
  format: string;
  specVersion: number;
  plugin: string;
  exportedAt: string;
  scope: string; // 'ALL' or a specific scope id
  backend: string; // 'json' | 'sqlite'
  memory: { store: Dict; summary: Dict; topic: Dict; notes: Dict<{ text: string; ts: number }[]> };
  facts: { scopes: Dict<Fact[]> };
  vectors: { model: string | null; vectors: Dict<VectorItem[]> };
  knowledge: { entries: KnowledgeEntry[] };
  reflection: { reflections: Reflection[]; rules: InteractionRule[]; stats: Dict };
  persona: { personas: Dict<Persona>; globalStyle: string };
  profiles: Dict<Profile>;
}

// ---------------------------------------------------------------------------
// Stem <-> friendly-bundle leaf mapping (the only place the two shapes differ)
// ---------------------------------------------------------------------------
type StemName = 'memory-data' | 'fact-store' | 'vector-memory' | 'knowledge-base' | 'reflection-data' | 'persona-data' | 'user-profiles';
const STEM_OF: Record<string, StemName> = {
  memory: 'memory-data',
  facts: 'fact-store',
  vectors: 'vector-memory',
  knowledge: 'knowledge-base',
  reflection: 'reflection-data',
  persona: 'persona-data',
  profiles: 'user-profiles',
};
const STEM_KEYS = Object.keys(STEM_OF) as (keyof typeof STEM_OF)[];

function defaultRaw(stem: StemName): unknown {
  switch (stem) {
    case 'memory-data': return { store: {}, summary: {}, topic: {}, notes: {} };
    case 'fact-store': return { scopes: {} };
    case 'vector-memory': return { vectors: {} };
    case 'knowledge-base': return { entries: [] };
    case 'reflection-data': return { reflections: [], interactionRules: [], stats: { totalConversations: 0, totalReflections: 0, lastReflectionTs: 0 } };
    case 'persona-data': return { personas: {}, globalStyle: '' };
    case 'user-profiles': return { profiles: {} };
  }
}

function leafToRaw(key: keyof typeof STEM_OF, leaf: unknown): unknown {
  switch (key) {
    case 'memory': return leaf;
    case 'facts': return { scopes: (leaf as any).scopes ?? {} };
    case 'vectors': return { vectors: (leaf as any).vectors ?? {}, ...((leaf as any).model ? { model_name: (leaf as any).model } : {}) };
    case 'knowledge': return { entries: (leaf as any).entries ?? [] };
    case 'reflection': return { reflections: (leaf as any).reflections ?? [], interactionRules: (leaf as any).rules ?? [], stats: (leaf as any).stats ?? {} };
    case 'persona': return { personas: (leaf as any).personas ?? {}, globalStyle: (leaf as any).globalStyle ?? '' };
    case 'profiles': return { profiles: leaf ?? {} };
  }
}

// ---------------------------------------------------------------------------
// Scope helpers
// ---------------------------------------------------------------------------
function filterMapScope<T>(obj: Dict<T>, scope?: string): Dict<T> {
  if (!scope || scope === 'ALL') return obj;
  return Object.prototype.hasOwnProperty.call(obj, scope) ? { [scope]: obj[scope] } : {};
}
function filterArrayScope<T extends { userId?: string }>(arr: T[], scope?: string): T[] {
  if (!scope || scope === 'ALL') return arr;
  return arr.filter((x) => String(x.userId ?? '') === scope);
}

// ---------------------------------------------------------------------------
// Build the canonical bundle from the active backend
// ---------------------------------------------------------------------------
export function buildBundle(backend: StoreBackend, scope?: string, backendKind?: string): ExportBundle {
  const s = (scope || '').trim();
  const memRaw = (backend.readJson('memory-data') ?? {}) as any;
  const factRaw = (backend.readJson('fact-store') ?? {}) as any;
  const vecRaw = (backend.readJson('vector-memory') ?? {}) as any;
  const kbRaw = (backend.readJson('knowledge-base') ?? {}) as any;
  const reflRaw = (backend.readJson('reflection-data') ?? {}) as any;
  const personaRaw = (backend.readJson('persona-data') ?? {}) as any;
  const profileRaw = (backend.readJson('user-profiles') ?? {}) as any;

  const memory = {
    store: filterMapScope(memRaw.store ?? {}, s),
    summary: filterMapScope(memRaw.summary ?? {}, s),
    topic: filterMapScope(memRaw.topic ?? {}, s),
    notes: filterMapScope(memRaw.notes ?? {}, s),
  };
  const facts = { scopes: filterMapScope(factRaw.scopes ?? {}, s) };
  const vectors = { model: vecRaw.model_name ?? null, vectors: filterMapScope(vecRaw.vectors ?? {}, s) };
  const knowledge = { entries: kbRaw.entries ?? [] };
  const reflection = {
    reflections: filterArrayScope(reflRaw.reflections ?? [], s),
    rules: filterArrayScope(reflRaw.interactionRules ?? [], s),
    stats: reflRaw.stats ?? {},
  };
  const persona = { personas: filterMapScope(personaRaw.personas ?? {}, s), globalStyle: personaRaw.globalStyle ?? '' };
  const profiles = filterMapScope(profileRaw.profiles ?? {}, s);

  return {
    format: EXPORT_FORMAT,
    specVersion: EXPORT_SPEC_VERSION,
    plugin: 'cortico-world-memory',
    exportedAt: new Date().toISOString(),
    scope: s || 'ALL',
    backend: backendKind ?? backend.kind ?? 'unknown',
    memory,
    facts,
    vectors,
    knowledge,
    reflection,
    persona,
    profiles,
  };
}

// ---------------------------------------------------------------------------
// Writers
// ---------------------------------------------------------------------------
export function writeBundleJson(bundle: ExportBundle, filePath: string): void {
  const dir = filePath.slice(0, Math.max(0, filePath.lastIndexOf('/')));
  // handle windows backslash too
  const d2 = filePath.slice(0, Math.max(0, filePath.lastIndexOf('\\')));
  const outDir = dir.length >= d2.length ? dir : d2;
  if (outDir) mkdirSync(outDir, { recursive: true });
  writeFileSync(filePath, JSON.stringify(bundle, null, 2), 'utf8');
}

export function writeBundleSqlite(bundle: ExportBundle, filePath: string): void {
  const dir = filePath.slice(0, Math.max(0, filePath.lastIndexOf('/')));
  const d2 = filePath.slice(0, Math.max(0, filePath.lastIndexOf('\\')));
  const outDir = dir.length >= d2.length ? dir : d2;
  if (outDir) mkdirSync(outDir, { recursive: true });
  if (existsSync(filePath)) writeFileSync(filePath, ''); // truncate existing db
  const db = new DatabaseSync(filePath);
  try {
    db.exec(`
      CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT);
      CREATE TABLE data (name TEXT PRIMARY KEY, value TEXT);
    `);
    const meta = [
      ['format', bundle.format],
      ['specVersion', String(bundle.specVersion)],
      ['plugin', bundle.plugin],
      ['exportedAt', bundle.exportedAt],
      ['scope', bundle.scope],
      ['backend', bundle.backend],
    ];
    const mStmt = db.prepare('INSERT INTO meta(key,value) VALUES (?,?)');
    for (const [k, v] of meta) mStmt.run(k, v);
    const dStmt = db.prepare('INSERT INTO data(name,value) VALUES (?,?)');
    for (const key of STEM_KEYS) {
      const leaf = (bundle as any)[key];
      if (leaf !== undefined) dStmt.run(key, JSON.stringify(leaf));
    }
  } finally {
    db.close();
  }
}

// ---------------------------------------------------------------------------
// Reader (auto-detect json vs sqlite by extension)
// ---------------------------------------------------------------------------
export function isSqlitePath(p: string): boolean {
  return /\.(sqlite|sqlite3?|db)$/i.test(p);
}

export interface ReadBundleResult {
  bundle: ExportBundle;
  source: 'json' | 'sqlite';
}

export function readBundleFromFile(filePath: string): ReadBundleResult {
  if (!existsSync(filePath)) throw new Error(`文件不存在: ${filePath}`);
  if (isSqlitePath(filePath)) return { bundle: readBundleSqlite(filePath), source: 'sqlite' };
  return { bundle: readBundleJson(filePath), source: 'json' };
}

function validateBundle(b: any): asserts b is ExportBundle {
  const required = ['memory', 'facts', 'vectors', 'knowledge', 'reflection', 'persona', 'profiles'];
  const missing = required.filter((k) => !(k in b));
  if (missing.length) {
    throw new Error(`文件不是有效的记忆导出包（缺少字段: ${missing.join(', ')}）。需为 cortico-memory-export 规范。`);
  }
  if (b.format && b.format !== EXPORT_FORMAT) {
    // allow legacy bundles that lack `format` but have the keys; warn otherwise
  }
}

function readBundleJson(filePath: string): ExportBundle {
  let raw: string;
  try {
    raw = readFileSync(filePath, 'utf8');
  } catch (e: any) {
    throw new Error(`读取 JSON 失败: ${e?.message ?? e}`);
  }
  let parsed: any;
  try {
    parsed = JSON.parse(raw);
  } catch (e: any) {
    throw new Error(`JSON 解析失败: ${e?.message ?? e}`);
  }
  validateBundle(parsed);
  if (!parsed.format) parsed.format = EXPORT_FORMAT;
  if (!parsed.specVersion) parsed.specVersion = EXPORT_SPEC_VERSION;
  if (!parsed.plugin) parsed.plugin = 'cortico-world-memory';
  if (!parsed.exportedAt) parsed.exportedAt = new Date().toISOString();
  if (!parsed.scope) parsed.scope = 'ALL';
  if (!parsed.backend) parsed.backend = 'unknown';
  return parsed as ExportBundle;
}

function readBundleSqlite(filePath: string): ExportBundle {
  const db = new DatabaseSync(filePath, { readOnly: true });
  let rows: { name: string; value: string }[] = [];
  let meta: { key: string; value: string }[] = [];
  try {
    const t = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name IN ('meta','data')").all() as any[];
    if (!t.find((x) => x.name === 'data')) throw new Error('SQLite 文件缺少 data 表，不是有效的记忆导出包。');
    rows = db.prepare('SELECT name, value FROM data').all() as any[];
    try {
      meta = db.prepare('SELECT key, value FROM meta').all() as any[];
    } catch { /* meta optional */ }
  } finally {
    db.close();
  }
  const byName = new Map(rows.map((r) => [r.name, r.value]));
  const m = new Map(meta.map((r) => [r.key, r.value]));
  const bundle: any = {
    format: m.get('format') ?? EXPORT_FORMAT,
    specVersion: Number(m.get('specVersion') ?? EXPORT_SPEC_VERSION),
    plugin: m.get('plugin') ?? 'cortico-world-memory',
    exportedAt: m.get('exportedAt') ?? new Date().toISOString(),
    scope: m.get('scope') ?? 'ALL',
    backend: m.get('backend') ?? 'sqlite',
  };
  for (const key of STEM_KEYS) {
    const v = byName.get(key);
    if (v !== undefined) {
      try { bundle[key] = JSON.parse(v); }
      catch { /* ignore malformed row */ }
    }
  }
  validateBundle(bundle);
  return bundle as ExportBundle;
}

// ---------------------------------------------------------------------------
// Per-stem merge (used by import). Maps are merged by sub-key (safe for scoped
// exports); arrays honour `mode`: 'merge' = concat+dedupe, 'replace' = replace.
// ---------------------------------------------------------------------------
export type ImportMode = 'merge' | 'replace';

function dedupeFacts(arr: Fact[]): Fact[] {
  const seen = new Set<string>();
  const out: Fact[] = [];
  for (const f of arr) {
    const key = (f.hash || f.fact).trim();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(f);
  }
  return out;
}
function dedupeVectors(arr: VectorItem[]): VectorItem[] {
  const seen = new Set<string>();
  const out: VectorItem[] = [];
  for (const v of arr) {
    const key = `${v.text}@${v.timestamp}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(v);
  }
  return out;
}
function dedupeKnowledge(arr: KnowledgeEntry[]): KnowledgeEntry[] {
  const seen = new Set<string>();
  const out: KnowledgeEntry[] = [];
  for (const e of arr) {
    const key = e.id ? `id:${e.id}` : `t:${e.topic.trim()}|${e.facts.join('|')}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(e);
  }
  return out;
}
function dedupeReflections(arr: Reflection[]): Reflection[] {
  const seen = new Set<string>();
  const out: Reflection[] = [];
  for (const r of arr) {
    const key = `${r.type}|${r.userId ?? ''}|${r.content.slice(0, 50)}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(r);
  }
  return out;
}
function dedupeRules(arr: InteractionRule[]): InteractionRule[] {
  const seen = new Set<string>();
  const out: InteractionRule[] = [];
  for (const r of arr) {
    const key = r.rule.slice(0, 50);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(r);
  }
  return out;
}
function mergeStats(a: Dict, b: Dict): Dict {
  const num = (o: Dict, k: string) => Number(o?.[k] ?? 0);
  return {
    totalConversations: Math.max(num(a, 'totalConversations'), num(b, 'totalConversations')),
    totalReflections: Math.max(num(a, 'totalReflections'), num(b, 'totalReflections')),
    lastReflectionTs: Math.max(num(a, 'lastReflectionTs'), num(b, 'lastReflectionTs')),
  };
}
function concat<T>(existing: T[], incoming: T[], mode: ImportMode, dedupe: (a: T[]) => T[]): T[] {
  if (mode === 'replace') return dedupe(incoming);
  return dedupe([...existing, ...incoming]);
}

/** Merge one incoming stem raw-object into the existing one, return merged raw. */
function mergeStem(stem: StemName, existing: any, incoming: any, mode: ImportMode): any {
  switch (stem) {
    case 'memory-data': {
      const e = existing ?? defaultRaw('memory-data');
      const i = incoming ?? defaultRaw('memory-data');
      return {
        store: { ...(e.store ?? {}), ...(i.store ?? {}) },
        summary: { ...(e.summary ?? {}), ...(i.summary ?? {}) },
        topic: { ...(e.topic ?? {}), ...(i.topic ?? {}) },
        notes: Object.fromEntries(
          Object.keys({ ...(e.notes ?? {}), ...(i.notes ?? {}) }).map((sc) => [
            sc,
            concat(e.notes?.[sc] ?? [], i.notes?.[sc] ?? [], mode, (a) => {
              const seen = new Set(a.map((n: any) => n.text));
              return a.filter((n: any, idx: number) => a.findIndex((m: any) => m.text === n.text) === idx);
            }),
          ]),
        ),
      };
    }
    case 'fact-store': {
      const e = existing?.scopes ?? {};
      const i = incoming?.scopes ?? {};
      const out: Dict<Fact[]> = { ...e };
      for (const sc of Object.keys(i)) {
        out[sc] = concat(e[sc] ?? [], i[sc] ?? [], mode, dedupeFacts);
      }
      return { scopes: out };
    }
    case 'vector-memory': {
      const e = existing ?? {};
      const i = incoming ?? {};
      const ev = e.vectors ?? {};
      const iv = i.vectors ?? {};
      const out: Dict<VectorItem[]> = { ...ev };
      for (const sc of Object.keys(iv)) {
        out[sc] = concat(ev[sc] ?? [], iv[sc] ?? [], mode, dedupeVectors);
      }
      return { vectors: out, ...(i.model_name ? { model_name: i.model_name } : (e.model_name ? { model_name: e.model_name } : {})) };
    }
    case 'knowledge-base': {
      const e = existing?.entries ?? [];
      const i = incoming?.entries ?? [];
      return { entries: concat(e, i, mode, dedupeKnowledge) };
    }
    case 'reflection-data': {
      const e = existing ?? {};
      const i = incoming ?? {};
      return {
        reflections: concat(e.reflections ?? [], i.reflections ?? [], mode, dedupeReflections),
        interactionRules: concat(e.interactionRules ?? [], i.interactionRules ?? [], mode, dedupeRules),
        stats: mergeStats(e.stats ?? {}, i.stats ?? {}),
      };
    }
    case 'persona-data': {
      const e = existing ?? {};
      const i = incoming ?? {};
      return {
        personas: { ...(e.personas ?? {}), ...(i.personas ?? {}) },
        globalStyle: i.globalStyle ? i.globalStyle : (e.globalStyle ?? ''),
      };
    }
    case 'user-profiles': {
      const e = existing?.profiles ?? {};
      const i = incoming?.profiles ?? {};
      return { profiles: { ...e, ...i } };
    }
  }
}

export interface ImportResult {
  importedScopes: string[];
  stems: string[];
}

/**
 * Apply an exported bundle onto the active backend and return a summary.
 * `bundle` is the canonical friendly bundle. Writes each stem via the backend
 * (works for both json & sqlite backends). Caller must reload in-memory stores.
 */
export function applyBundle(backend: StoreBackend, bundle: ExportBundle, mode: ImportMode = 'merge'): ImportResult {
  const importedScopes = new Set<string>();
  const stems: string[] = [];
  for (const key of STEM_KEYS) {
    const leaf = (bundle as any)[key];
    if (leaf === undefined) continue;
    const stem = STEM_OF[key];
    const incoming = leafToRaw(key, leaf);
    const existing = backend.readJson(stem) ?? defaultRaw(stem);
    const merged = mergeStem(stem, existing, incoming, mode);
    backend.writeJson(stem, merged);
    stems.push(stem);
  }
  // collect scopes actually touched for a summary
  for (const sc of Object.keys(bundle.facts?.scopes ?? {})) importedScopes.add(sc);
  for (const sc of Object.keys(bundle.vectors?.vectors ?? {})) importedScopes.add(sc);
  for (const sc of Object.keys(bundle.memory?.store ?? {})) importedScopes.add(sc);
  for (const sc of Object.keys(bundle.profiles ?? {})) importedScopes.add(sc);
  for (const sc of Object.keys(bundle.persona?.personas ?? {})) importedScopes.add(sc);
  return { importedScopes: [...importedScopes], stems };
}

// ---------------------------------------------------------------------------
// Format token parsing for the export tool (keeps backward compat)
// ---------------------------------------------------------------------------
export function parseFormatTokens(format?: string): Set<'json' | 'markdown' | 'sqlite'> {
  const out = new Set<'json' | 'markdown' | 'sqlite'>();
  const raw = (format || '').trim().toLowerCase();
  if (!raw || raw === 'both') {
    out.add('json');
    out.add('markdown');
    return out;
  }
  if (raw === 'all') {
    out.add('json');
    out.add('markdown');
    out.add('sqlite');
    return out;
  }
  for (const tok of raw.split(/[|,; ]+/)) {
    if (!tok) continue;
    if (tok === 'json') out.add('json');
    else if (tok === 'md' || tok === 'markdown') out.add('markdown');
    else if (tok === 'sqlite' || tok === 'db') out.add('sqlite');
  }
  return out;
}
