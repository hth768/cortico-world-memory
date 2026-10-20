// mem_recall 召回结果格式化:长度封顶,避免把超长记忆(尤其是自动捕获的整段聊天)原样吐回上下文。
//
// 事故背景:FactStore 写入时不截断,而自动捕获会把整条入站消息(可能数千字)原样存进事实库;
// mem_recall 优先返回事实全文 → 单条超长、或多条叠加,极易远超上下文预算(用户反馈 >8000)。

/** 单条召回文本展示上限(字符)。 */
export const RECALL_ITEM_MAX = 1500;
/** 单次召回总字符预算(用户侧反馈阈值约 8000,留一些余量)。 */
export const RECALL_BUDGET = 8000;
/** 单次召回最多条数(与 mem_recall 的 top_k 上限一致)。 */
export const RECALL_MAX_ITEMS = 20;

export interface RecallFormatOptions {
  itemMax?: number;
  budget?: number;
  maxItems?: number;
}

export interface RecallFormatted {
  body: string;
  shown: number;
  total: number;
}

/**
 * 把召回到的原始文本列表格式化为带序号的文本。
 * - 按原文去重(避免事实与向量命中同一条时重复);
 * - 单条超过 itemMax 截断加「…」;
 * - 累计超过 budget 预算即停止(至少保留 1 条);
 * - 最多 maxItems 条。
 */
export function formatRecallResults(
  items: string[],
  opts: RecallFormatOptions = {},
): RecallFormatted {
  const itemMax = opts.itemMax ?? RECALL_ITEM_MAX;
  const budget = opts.budget ?? RECALL_BUDGET;
  const maxItems = opts.maxItems ?? RECALL_MAX_ITEMS;

  const seen = new Set<string>();
  const out: string[] = [];
  let used = 0;
  for (const raw of items) {
    if (seen.has(raw)) continue;
    if (out.length >= maxItems) break;
    const text = raw.length > itemMax ? raw.slice(0, itemMax) + '…' : raw;
    if (out.length && used + text.length + 4 > budget) break; // 预算到顶(至少保留已加的)
    seen.add(raw);
    used += text.length + 4;
    out.push(text);
  }
  return {
    body: out.map((t, i) => `${i + 1}. ${t}`).join('\n'),
    shown: out.length,
    total: items.length,
  };
}
