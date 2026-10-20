// 把记忆状态拼成「她此刻能想起的东西」——对应 qq_bot memory_context.build_memory_messages
// 的注入语义,但走 Cortico 的 envPrompt 插值 + 事件推送两条通道。
import type { MemoryBase } from './memory.ts';
import type { VectorStore } from './vector-store.ts';
import type { ProfileStore } from './profile-store.ts';

export interface MemoryView {
  topic: string;
  summary: string;
  notes: Array<{ text: string; ts: number }>;
  scopes: string[];
  vectorStats: { scopes: number; total: number; indexed: number; model: string };
  profileHint: string;
}

export function buildView(mem: MemoryBase, vectors: VectorStore, scope: string, notesInPrompt: number, profile: ProfileStore | null): MemoryView {
  return {
    topic: mem.getTopic(scope),
    summary: mem.getSummary(scope),
    notes: mem.getNotes(scope).slice(-notesInPrompt),
    scopes: mem.scopes(),
    vectorStats: vectors.stats(),
    profileHint: profile ? profile.hint(scope) : '',
  };
}

/** 环境提示词的动态变量值(envPromptVars 用;快,纯内存读)。 */
export function promptVars(view: MemoryView): Record<string, string> {
  const lines: string[] = [];
  if (view.profileHint) {
    lines.push('【人物档案】');
    lines.push(view.profileHint);
  }
  if (view.notes.length) {
    lines.push('【重要信息】(用户/你明确要求记住的)');
    view.notes.forEach((n, i) => lines.push(`${i + 1}. ${n.text}`));
  }
  if (view.summary) lines.push(`【之前的对话摘要】${view.summary}`);
  if (view.topic) lines.push(`【当前话题】${view.topic}`);
  const { total, indexed } = view.vectorStats;
  lines.push(`【记忆库】长期记忆 ${total} 条(其中 ${indexed} 条已建向量索引)。`);
  return {
    memoryContext: lines.join('\n'),
    memoryScopes: view.scopes.join(', ') || '(无)',
    memoryVectors: `${indexed}/${total}`,
  };
}

/**
 * 快照语义指纹:只取「她记得什么」的字段(档案/摘要/话题/要点),忽略向量条数这类易变统计。
 * 用于周期推送去重——没有它,30s 一拍会把同一份长文本重复塞进事件队列。
 */
export function snapshotSignature(view: MemoryView): string {
  return [view.profileHint, view.summary, view.topic, view.notes.map((n) => n.text).join('\u0001')].join('\u0000');
}

/** 周期推送用的事件正文(比提示词变量更啰嗦,给人格当「记忆快照」)。 */
export function buildEventText(view: MemoryView): string {
  const lines: string[] = ['# 记忆快照 (memory)'];
  const { total, indexed, scopes } = view.vectorStats;
  lines.push(`- 记忆域: ${view.scopes.join(', ') || '(空)'} / 向量索引: ${indexed}/${total} 条 / 库: ${scopes || '无'}`);
  if (view.topic) lines.push(`- 当前话题: ${view.topic}`);
  if (view.profileHint) lines.push(`- 人物档案: ${view.profileHint}`);
  if (view.summary) lines.push(`- 对话摘要: ${view.summary}`);
  if (view.notes.length) lines.push(`- 重要信息: ${view.notes.map((n) => n.text).join(' / ')}`);
  lines.push(`\n要记的事用 mem_remember / mem_note 存;找旧账用 mem_recall 混合检索;没别的就用 mem_recall 或继续手头的事。`);
  return lines.join('\n');
}
