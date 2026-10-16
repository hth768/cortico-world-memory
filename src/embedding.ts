/**
 * Embedding 客户端 —— qq_bot「重负载外置 + 掉线降级」语义的移植:
 *  - `http`:POST OpenAI 兼容 `{model,input}` → `{data:[{embedding:[...]}]}`(本机 ollama 等)。
 *  - `sidecar`:qq_bot 的 memory_server(HTTP RPC),`POST {url}/call` 调
 *    `vector_memory.generate_embedding`,返回 384 维 MiniLM 向量或 null。
 *  - `off`:不出网,返回 null(调用方仅走 BM25)。
 * 任一模式失败都静默降级返回 null —— 对齐 memory_client「sidecar 掉线,bot 永不停摆」。
 */
import type { MemoryConfig } from './config.ts';

export type VectorSource = 'http' | 'sidecar' | 'off';

export class EmbeddingClient {
  constructor(private readonly cfg: MemoryConfig) {}

  get provider(): VectorSource {
    const p = this.cfg.embeddingProvider;
    return p === 'http' || p === 'sidecar' ? p : 'off';
  }

  /** 生成一条文本向量;不可用 / 失败返回 null(绝不抛)。 */
  async embed(text: string): Promise<readonly number[] | null> {
    const trimmed = text.trim();
    if (!trimmed) return null;
    try {
      switch (this.provider) {
        case 'http': return await this.embedHttp(trimmed);
        case 'sidecar': return await this.embedSidecar(trimmed);
        default: return null;
      }
    } catch {
      return null; // 降级:只影响向量路,BM25 照常
    }
  }

  private async embedHttp(text: string): Promise<readonly number[] | null> {
    const endpoint = this.cfg.embeddingEndpoint;
    if (!endpoint) return null;
    const res = await fetch(endpoint, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: this.cfg.embeddingModel || 'default', input: text }),
      signal: AbortSignal.timeout(Math.min(this.cfg.embeddingTimeoutMs, 60_000)),
    });
    if (!res.ok) return null;
    const json = (await res.json()) as { data?: Array<{ embedding?: number[] }> };
    const embedding = json.data?.[0]?.embedding;
    return Array.isArray(embedding) && embedding.length ? embedding : null;
  }

  /** qq_bot memory_server 的通用 RPC:`{module, func, args}` → `{ok, result}`。 */
  private async embedSidecar(text: string): Promise<readonly number[] | null> {
    const base = (this.cfg.embeddingSidecarUrl || 'http://127.0.0.1:8766').replace(/\/+$/, '');
    const res = await fetch(`${base}/call`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ module: 'vector_memory', func: 'generate_embedding', args: [text] }),
      signal: AbortSignal.timeout(this.cfg.embeddingTimeoutMs),
    });
    if (!res.ok) return null;
    const json = (await res.json()) as { ok?: boolean; result?: unknown };
    if (!json.ok) return null;
    const result = json.result;
    if (!Array.isArray(result) || !result.length) return null;
    return result.every((n) => typeof n === 'number' && Number.isFinite(n)) ? (result as number[]) : null;
  }

  /** 探测 sidecar 是否在线(仅 sidecar 模式;用于启动日志与 mem_stats)。 */
  async sidecarHealthy(): Promise<boolean | null> {
    if (this.provider !== 'sidecar') return null;
    try {
      const base = (this.cfg.embeddingSidecarUrl || 'http://127.0.0.1:8766').replace(/\/+$/, '');
      const res = await fetch(`${base}/health`, { signal: AbortSignal.timeout(3000) });
      return res.ok;
    } catch {
      return false;
    }
  }
}
