import type { DescribeText, EventDescribe } from 'cortico/core/types.ts';
import type { WorldDefinition } from 'cortico/world.ts';
import { describeTools } from 'cortico/world.ts';
import { MEMORY_DEFAULTS, type MemoryConfig } from './config.ts';
import { MemoryWorld } from './world.ts';

/** 每个工具一句给人看的话;市场与扩展页按界面语言取。 */
const TOOL_SUMMARIES: Record<string, DescribeText> = {
  mem_remember: {
    zh: '把一件值得长期记住的事写进长期记忆,顺带『事实库』去重与向量索引。',
    en: 'Store something worth remembering long-term, deduplicated and indexed for later recall.',
  },
  mem_recall: {
    zh: '按语义加关键词混合检索长期记忆,找旧账、回忆约定时用。',
    en: 'Search long-term memory with hybrid semantic and keyword recall, for old promises and shared history.',
  },
  mem_recent: {
    zh: '回看本记忆域最近的短期对话。',
    en: 'Read the most recent short-term turns in this scope.',
  },
  mem_overflow: {
    zh: '取出已溢出短期窗口的最旧条目,好把它们压缩进摘要。',
    en: 'Fetch the oldest entries that fell out of the short-term window so they can be rolled into the summary.',
  },
  mem_summary: {
    zh: '读或写本记忆域的对话摘要。',
    en: 'Read or replace the conversation summary of this scope.',
  },
  mem_topic: {
    zh: '读或写当前话题,让上下文保持连贯。',
    en: 'Read or update the current topic to keep the context coherent.',
  },
  mem_note: {
    zh: '记一条常驻提示词的重要信息或硬约束。',
    en: 'Record a persistent note or hard constraint that stays in the environment prompt.',
  },
  mem_notes: {
    zh: '列出本记忆域的全部重要信息及编号。',
    en: 'List every persistent note in this scope together with its index.',
  },
  mem_forget_note: {
    zh: '按编号删掉一条重要信息,先 mem_notes 确认编号再用。',
    en: 'Delete a persistent note by index; check mem_notes for the index first.',
  },
  mem_knowledge: {
    zh: '沉淀一条可复用的通用知识条目,同主题自动合并。',
    en: 'Add a reusable, topic-organized piece of general knowledge, merged into existing topics.',
  },
  mem_knowledge_fact: {
    zh: '把单条知识文本直接记进知识库。',
    en: 'File a single knowledge sentence straight into the knowledge base.',
  },
  mem_knowledge_recall: {
    zh: '回答前先查知识库,命中就直接复用。',
    en: 'Check the knowledge base before answering and reuse any hit directly.',
  },
  mem_knowledge_list: {
    zh: '列出知识库的全部主题,便于总览已沉淀的知识。',
    en: 'List every knowledge topic for an overview of what has been learned.',
  },
  mem_reflect: {
    zh: '沉淀一条反思、偏好或纠错,可执行的会被提炼成规则。',
    en: 'Record a reflection, preference or correction; actionable ones are distilled into rules.',
  },
  mem_reflect_rules: {
    zh: '列出由可执行反思提炼出的交互规则。',
    en: 'List the interaction rules distilled from actionable reflections.',
  },
  mem_persona: {
    zh: '记录与某个用户独特的相处模式,按用户隔离。',
    en: 'Record how to relate to one particular user, kept separate per user.',
  },
  mem_persona_get: {
    zh: '读取某个用户的人格记忆。',
    en: 'Read the persona memory of one user.',
  },
  mem_persona_global: {
    zh: '设置或读取跨用户统一的全局人格基调。',
    en: 'Set or read the global persona tone shared across all users.',
  },
  mem_profile: {
    zh: '记入或更新某个用户的人物档案,常驻进提示词。',
    en: 'Add to or update a user profile that stays in the environment prompt.',
  },
  mem_profile_replace: {
    zh: '整体替换某个用户的人物档案,用于纠错。',
    en: 'Replace a user profile wholesale, for corrections.',
  },
  mem_profile_get: {
    zh: '读取某个用户的人物档案。',
    en: 'Read the profile of one user.',
  },
  mem_stats: {
    zh: '查看记忆库的规模、记忆域与向量索引覆盖情况。',
    en: 'Show the memory store size, its scopes and how much the vector index covers.',
  },
  mem_capture_now: {
    zh: '立刻把新入站的用户消息沉淀进记忆,不等轮询周期。',
    en: 'Fold newly arrived user messages into memory now, without waiting for the poll.',
  },
  mem_flush: {
    zh: '把记忆立即落盘,平时会自动防抖写入。',
    en: 'Flush memory to disk immediately; writes are debounced by default.',
  },
  mem_export: {
    zh: '导出整个记忆库的快照。',
    en: 'Export a snapshot of the whole memory store.',
  },
};

const MEMORY_EVENTS: EventDescribe[] = [
  {
    type: 'memory.context',
    description: {
      zh: '记忆快照:要点、摘要、当前话题与记忆域统计的拼接文本,每轮构建上下文时现取。',
      en: 'A memory snapshot: notes, summary, current topic and store statistics joined into one text, taken fresh each turn.',
    },
    // 事件 + piggyback:进会话历史但不唤醒回合,否则记忆周期会让 bot 自言自语。
    trigger: 'piggyback',
  },
];

export const MEMORY_WORLD: WorldDefinition<MemoryConfig> = {
  id: 'memory',
  label: '记忆系统',
  defaults: () => ({ ...MEMORY_DEFAULTS }),
  create: (ctx) => new MemoryWorld(ctx),
  describe: {
    tools: describeTools(MemoryWorld.describeToolSpecs(), TOOL_SUMMARIES),
    events: MEMORY_EVENTS,
  },
};
