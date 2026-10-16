/**
 * 向量记忆库 —— 移植自 E:/qq_bot/vector_memory.py(N.E.K.O Hybrid Recall 架构),qq_bot 源码零改动。
 *
 * 语义逐项对齐:
 *  - 存储:JSON `{vectors: {scope: [{text, vector(base64 fp16), timestamp}]}}`,同款文件格式,
 *    可直接导入 E:/qq_bot/vector_memory.json(或反向导出)。
 *  - 检索:Hybrid Recall = BM25 关键词 + Cosine 向量 + RRF 融合(k=60)。
 *  - BM25:仅为 query 词建 DF 表(不为全语料建),CJK 2/3-gram + Latin 整词分词。
 *  - Cosine:存储时 L2 归一化,检索时点积;矩阵按 scope 缓存,数据版本号失效。
 *  - 降级:无向量记录 / 维度不齐 / embedding 服务不在,都自动退化为纯 BM25——
 *    与 qq_bot memory_client「sidecar 掉线降级进程内、功能永不中断」同一思路。
 */
import { decodeVectorFp16, encodeVectorFp16 } from './float16.ts';
import { StoreBackend, JsonBackend } from './backend.ts';

const BM25_K1 = 1.5;
const BM25_B = 0.75;
const RRF_K = 60;

export interface VectorItem {
  /** 原文(截断到 200 字,对齐 python 版)。 */
  text: string;
  /** base64(fp16) 编码的 L2 归一化向量;文本-only 条目(BM25-only)为 null。 */
  vector: string | null;
  timestamp: number;
}

export interface VectorData {
  vectors: Record<string, VectorItem[]>;
  model_name?: string;
}

export interface SearchHit {
  text: string;
  /** 融合分数(RRF);单路结果时是归一化后的相对排名分,仅供展示排序。 */
  score: number;
  /** 命中来源:bm25 / vector / both。 */
  via: 'bm25' | 'vector' | 'both';
}

interface MatrixCache {
  matrix: Float32Array; // n × dim 的行主序
  dim: number;
  rows: number[]; // matrix 第 i 行对应 vectors[scope] 的下标
}

const MATRIX_CACHE_MAX = 64;

function l2Normalize(v: Float32Array): Float32Array {
  let norm = 0;
  for (let i = 0; i < v.length; i++) norm += v[i]! * v[i]!;
  norm = Math.sqrt(norm);
  if (norm === 0 || !Number.isFinite(norm)) return v;
  for (let i = 0; i < v.length; i++) v[i] = v[i]! / norm;
  return v;
}

/** CJK 2/3-gram + Latin 整词分词,对齐 `_tokenize_cjk_ngram`(简繁折叠依赖未装时原文照分)。 */
export function tokenizeCjkNgram(text: string): string[] {
  const tokens: string[] = [];
  const pattern = /[\u4e00-\u9fff\u3400-\u4dbf\uf900-\ufaff]+|[a-zA-Z0-9_]+/g;
  const cjk = /^[\u4e00-\u9fff\u3400-\u4dbf\uf900-\ufaff]/;
  for (const seg of text.toLowerCase().match(pattern) ?? []) {
    if (cjk.test(seg)) {
      for (const n of [2, 3]) {
        for (let i = 0; i + n <= seg.length; i++) tokens.push(seg.slice(i, i + n));
      }
    } else {
      tokens.push(seg);
    }
  }
  return tokens;
}

/** Okapi BM25:仅为 query 词建 DF 表(对齐 `_bm25_score` 的优化点)。 */
function bm25Score(queryTokens: string[], docTokens: string[][]): number[] {
  const nDocs = docTokens.length;
  if (nDocs === 0) return [];
  const docLens = docTokens.map((t) => t.length);
  const avgdl = docLens.reduce((a, b) => a + b, 0) / nDocs || 1;
  const querySet = new Set(queryTokens);
  const df = new Map<string, number>();
  const tf: Array<Map<string, number>> = [];
  for (const tokens of docTokens) {
    const docTf = new Map<string, number>();
    for (const t of tokens) {
      if (!querySet.has(t)) continue;
      docTf.set(t, (docTf.get(t) ?? 0) + 1);
    }
    tf.push(docTf);
    for (const t of docTf.keys()) df.set(t, (df.get(t) ?? 0) + 1);
  }
  const scores: number[] = [];
  for (let i = 0; i < nDocs; i++) {
    let score = 0;
    const dl = docLens[i]!;
    for (const token of querySet) {
      const d = df.get(token);
      if (!d) continue;
      const idf = Math.log((nDocs - d + 0.5) / (d + 0.5) + 1);
      const f = tf[i]!.get(token) ?? 0;
      score += idf * ((f * (BM25_K1 + 1)) / (f + BM25_K1 * (1 - BM25_B + BM25_B * (dl / avgdl))));
    }
    scores.push(score);
  }
  return scores;
}

/** Reciprocal Rank Fusion,对齐 `_reciprocal_rank_fusion`(k=60)。 */
function rrfFusion(rankedLists: Array<Array<{ idx: number }>>): Map<number, number> {
  const scores = new Map<number, number>();
  for (const list of rankedLists) {
    list.forEach((item, rank) => {
      scores.set(item.idx, (scores.get(item.idx) ?? 0) + 1 / (RRF_K + rank + 1));
    });
  }
  return scores;
}

/** 一个 scope 的向量库(磁盘持久化 + 内存缓存 + 矩阵缓存 + 防抖写盘)。 */
export class VectorStore {
  private data: VectorData = { vectors: {} };
  private readonly stem = 'vector-memory';
  private readonly backend: StoreBackend;
  private matrices = new Map<string, { version: number; m: MatrixCache | null }>();
  private versions = new Map<string, number>;
  private dirty = false;
  private lastSave = 0;
  private flushTimer: ReturnType<typeof setTimeout> | null = null;

  static readonly SAVE_DEBOUNCE_MS = 2000;

  constructor(dataDir: string, backend?: StoreBackend) {
    this.backend = backend ?? new JsonBackend(dataDir);
    this.load();
  }

  private load(): void {
    const raw = this.backend.readJson(this.stem) as VectorData | null;
    if (!raw || typeof raw !== 'object' || !raw.vectors || typeof raw.vectors !== 'object') return;
    try {
      this.data = { vectors: raw.vectors, ...(raw.model_name ? { model_name: raw.model_name } : {}) };
    } catch { /* 损坏文件按空库起步,与 python 版同策略 */ }
  }

  /** 同步全量写(JSON 体量 = 条数×维度/2 字节,500 条×384 维约 1.5MB,可接受)。 */
  private saveNow(): void {
    try {
      this.backend.writeJson(this.stem, this.data);
      this.dirty = false;
      this.lastSave = Date.now();
    } catch { /* 磁盘失败不打断主流程;下次写入再试 */ }
  }

  /** 防抖调度写盘:距上次写 < 2s 则延迟合并,否则立即写。与 MemoryBase.scheduleSave 对齐。 */
  private scheduleSave(): void {
    const now = Date.now();
    if (now - this.lastSave < VectorStore.SAVE_DEBOUNCE_MS) {
      this.dirty = true;
      if (!this.flushTimer) {
        this.flushTimer = setTimeout(() => { this.flushTimer = null; this.saveNow(); }, VectorStore.SAVE_DEBOUNCE_MS);
        this.flushTimer.unref?.();
      }
      return;
    }
    this.saveNow();
  }

  /** 强制立即落盘(防抖到期 / stop 时调用)。 */
  flush(): void {
    if (this.flushTimer) { clearTimeout(this.flushTimer); this.flushTimer = null; }
    if (this.dirty || !this.lastSave) this.saveNow();
  }

  private invalidate(scope: string): void {
    this.versions.set(scope, (this.versions.get(scope) ?? 0) + 1);
  }

  /** 追加一条;vector 为 null 时仅进 BM25 索引。超出上限截掉最旧的。 */
  add(scope: string, text: string, vector: readonly number[] | null, maxPerScope: number): void {
    const s = scope || 'main';
    const list = (this.data.vectors[s] ??= []);
    list.push({
      text: text.slice(0, 200),
      vector: vector && vector.length ? encodeVectorFp16(vector) : null,
      timestamp: Date.now() / 1000,
    });
    if (list.length > maxPerScope) this.data.vectors[s] = list.slice(-maxPerScope);
    this.invalidate(s);
    this.scheduleSave(); // 防抖写盘(原为每次 add 都同步 save)
  }

  private matrixFor(scope: string): MatrixCache | null {
    const version = this.versions.get(scope) ?? 0;
    const cached = this.matrices.get(scope);
    if (cached && cached.version === version) return cached.m;
    const items = this.data.vectors[scope] ?? [];
    let dim = 0;
    const rows: number[] = [];
    const chunks: Float32Array[] = [];
    for (let i = 0; i < items.length; i++) {
      const enc = items[i]!.vector;
      if (!enc) continue;
      const v = l2Normalize(decodeVectorFp16(enc));
      if (dim === 0) dim = v.length;
      if (v.length !== dim) continue; // 维度不齐的条目(换过模型)跳过,不炸整库
      chunks.push(v);
      rows.push(i);
    }
    let m: MatrixCache | null = null;
    if (rows.length) {
      const matrix = new Float32Array(rows.length * dim);
      chunks.forEach((v, r) => matrix.set(v, r * dim));
      m = { matrix, dim, rows };
    }
    if (this.matrices.size >= MATRIX_CACHE_MAX) {
      const oldest = this.matrices.keys().next().value;
      if (oldest !== undefined) this.matrices.delete(oldest);
    }
    this.matrices.set(scope, { version, m });
    return m;
  }

  /** 点积检索:matrix 已归一化,点积即余弦。返回 [下标, 相似度] 降序。 */
  private cosineSearch(scope: string, queryVector: readonly number[], topK: number): Array<{ idx: number; score: number }> {
    const m = this.matrixFor(scope);
    if (!m || m.rows.length === 0 || queryVector.length !== m.dim) return [];
    const q = l2Normalize(Float32Array.from(queryVector));
    const n = m.rows.length;
    const scores = new Float32Array(n);
    for (let r = 0; r < n; r++) {
      let dot = 0;
      const base = r * m.dim;
      for (let d = 0; d < m.dim; d++) dot += m.matrix[base + d]! * q[d]!;
      scores[r] = dot;
    }
    const order = [...Array(n).keys()]
      .filter((r) => scores[r]! > 0.3) // 对齐 python 版:融合前滤掉低相似度
      .sort((a, b) => scores[b]! - scores[a]!)
      .slice(0, topK);
    return order.map((r) => ({ idx: m.rows[r]!, score: scores[r]! }));
  }

  /** BM25 检索,返回 [下标, 分数] 降序(>0)。 */
  private bm25Search(scope: string, query: string, topK: number): Array<{ idx: number; score: number }> {
    const items = this.data.vectors[scope] ?? [];
    if (!items.length) return [];
    const queryTokens = tokenizeCjkNgram(query);
    if (!queryTokens.length) return [];
    const docTokens = items.map((it) => tokenizeCjkNgram(it.text));
    const scores = bm25Score(queryTokens, docTokens);
    return scores
      .map((score, idx) => ({ idx, score }))
      .filter((x) => x.score > 0)
      .sort((a, b) => b.score - a.score)
      .slice(0, topK);
  }

  /**
   * Hybrid Recall:BM25 + Cosine 并行打分,RRF 融合取 top_k。
   * 任一路没有结果时融合另一路;两路都空返回 []。
   */
  hybridSearch(scope: string, query: string, queryVector: readonly number[] | null, topK: number): SearchHit[] {
    const s = scope || 'main';
    const items = this.data.vectors[s] ?? [];
    if (!items.length) return [];
    const bm25 = this.bm25Search(s, query, topK * 2);
    const cosine = queryVector ? this.cosineSearch(s, queryVector, topK * 2) : [];
    if (!bm25.length && !cosine.length) return [];
    const fused = rrfFusion([bm25, cosine]);
    const viaVector = new Set(cosine.map((c) => c.idx));
    const viaBm25 = new Set(bm25.map((c) => c.idx));
    return [...fused.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, topK)
      .map(([idx, score]) => ({
        text: items[idx]!.text,
        score: +score.toFixed(4),
        via: viaBm25.has(idx) && viaVector.has(idx) ? 'both' : viaVector.has(idx) ? 'vector' : 'bm25',
      }));
  }

  /** BM25 检索(全局条目池),返回 [下标, 分数] 降序(>0)。 */
  private bm25SearchAll(items: VectorItem[], query: string, topK: number): Array<{ idx: number; score: number }> {
    if (!items.length) return [];
    const queryTokens = tokenizeCjkNgram(query);
    if (!queryTokens.length) return [];
    const docTokens = items.map((it) => tokenizeCjkNgram(it.text));
    const scores = bm25Score(queryTokens, docTokens);
    return scores
      .map((score, idx) => ({ idx, score }))
      .filter((x) => x.score > 0)
      .sort((a, b) => b.score - a.score)
      .slice(0, topK);
  }

  /** 点积检索(全局条目池,逐条解码构建矩阵),返回 [下标, 分数] 降序(>0.3)。 */
  private cosineSearchAll(items: VectorItem[], queryVector: readonly number[], topK: number): Array<{ idx: number; score: number }> {
    let dim = 0;
    const rows: number[] = [];
    const chunks: Float32Array[] = [];
    for (let i = 0; i < items.length; i++) {
      const enc = items[i]!.vector;
      if (!enc) continue;
      const v = l2Normalize(decodeVectorFp16(enc));
      if (dim === 0) dim = v.length;
      if (v.length !== dim) continue; // 维度不齐(换过模型)跳过
      chunks.push(v);
      rows.push(i);
    }
    if (!rows.length || queryVector.length !== dim) return [];
    const q = l2Normalize(Float32Array.from(queryVector));
    const matrix = new Float32Array(rows.length * dim);
    chunks.forEach((v, r) => matrix.set(v, r * dim));
    const scores = new Float32Array(rows.length);
    for (let r = 0; r < rows.length; r++) {
      let dot = 0;
      const base = r * dim;
      for (let d = 0; d < dim; d++) dot += matrix[base + d]! * q[d]!;
      scores[r] = dot;
    }
    return [...Array(rows.length).keys()]
      .filter((r) => scores[r]! > 0.3)
      .sort((a, b) => scores[b]! - scores[a]!)
      .slice(0, topK)
      .map((r) => ({ idx: rows[r]!, score: scores[r]! }));
  }

  /**
   * 跨 scope Hybrid Recall:把所有 scope 的条目汇总成一个全局池,跑 BM25 + Cosine + RRF。
   * 用于「自动捕获的对话」与显式事实共存时,scope 留空也能搜到对话域。
   */
  hybridSearchAll(query: string, queryVector: readonly number[] | null, topK: number): SearchHit[] {
    const all: VectorItem[] = [];
    for (const list of Object.values(this.data.vectors)) for (const it of list) all.push(it);
    if (!all.length) return [];
    const bm25 = this.bm25SearchAll(all, query, topK * 2);
    const cosine = queryVector ? this.cosineSearchAll(all, queryVector, topK * 2) : [];
    if (!bm25.length && !cosine.length) return [];
    const fused = rrfFusion([bm25, cosine]);
    const viaVector = new Set(cosine.map((c) => c.idx));
    const viaBm25 = new Set(bm25.map((c) => c.idx));
    return [...fused.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, topK)
      .map(([idx, score]) => ({
        text: all[idx]!.text,
        score: +score.toFixed(4),
        via: viaBm25.has(idx) && viaVector.has(idx) ? 'both' : viaVector.has(idx) ? 'vector' : 'bm25',
      }));
  }

  /** 统计信息,对齐 `get_vector_stats`。 */
  stats(): { scopes: number; total: number; indexed: number; model: string } {
    const vectors = this.data.vectors;
    let total = 0;
    let indexed = 0;
    for (const list of Object.values(vectors)) {
      total += list.length;
      indexed += list.filter((it) => it.vector).length;
    }
    return { scopes: Object.keys(vectors).length, total, indexed, model: this.data.model_name ?? '' };
  }

  /** 清空:带 scope 清该 scope,不带清全库。对齐 `clear_vectors`。 */
  clear(scope?: string): void {
    if (scope) {
      delete this.data.vectors[scope];
      this.invalidate(scope);
    } else {
      this.data.vectors = {};
      this.matrices.clear();
      this.versions.clear();
    }
    this.scheduleSave(); // 防抖写盘
  }

  /** 原始条目(调试/导出用)。 */
  items(scope: string): readonly VectorItem[] {
    return this.data.vectors[scope] ?? [];
  }

  setModelName(name: string): void {
    if (name && name !== this.data.model_name) {
      this.data.model_name = name;
      this.scheduleSave(); // 防抖写盘
    }
  }
}
