import { mkdtempSync, rmSync, existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { FactStore } from './src/fact-store.ts';
import { VectorStore } from './src/vector-store.ts';
import { KnowledgeStore } from './src/knowledge-store.ts';
import { ReflectionStore } from './src/reflection-store.ts';
import { PersonaStore } from './src/persona-store.ts';
import { ProfileStore } from './src/profile-store.ts';
import { MemoryWorld } from './src/world.ts';
import { MEMORY_DEFAULTS } from './src/config.ts';
import type { EventEnvelope } from 'cortico/core/types.ts';

const dir = mkdtempSync(join(tmpdir(), 'mem-smoke-'));
let pass = 0, fail = 0;
const ok = (name: string, cond: boolean) => { if (cond) { pass++; console.log('  ✓', name); } else { fail++; console.log('  ✗', name); } };

// fact_store
const facts = new FactStore(dir);
ok('fact add 新', facts.add('main', ['鱼娘最讨厌被叫胖']));
ok('fact add 重复跳过', !facts.add('main', ['鱼娘最讨厌被叫胖']));
ok('fact recall 命中', facts.recall('main', '鱼娘 叫', 5).some((h) => h.text.includes('胖')));

// knowledge_store
const kb = new KnowledgeStore(dir);
const r1 = kb.addEntry('Cortico', ['框架用 world 契约', 'v5 才加载'], ['框架'], ['doc']);
ok('kb 新主题', r1.ok && !r1.merged && r1.newFacts === 2);
const r2 = kb.addEntry('Cortico', ['框架用 world 契约', 'embedding 可关'], ['框架'], ['doc']);
ok('kb 主题合并+事实去重', r2.ok && r2.merged && r2.newFacts === 1);
ok('kb recall 命中(中文事实)', kb.recall('world 契约', 3).length >= 1);
ok('kb recall 命中(英文token)', kb.recall('embedding', 3).length >= 1);

// reflection_store
const rf = new ReflectionStore(dir);
const a1 = rf.reflect('用户偏好简短回复', 'preference', 'u1', undefined, 0.9, true);
ok('reflect 新增', a1.added);
const a2 = rf.reflect('用户偏好简短回复', 'preference', 'u1', undefined, 0.9, true);
ok('reflect 去重返回false', !a2.added);
ok('reflect 提炼规则', rf.getFor('u1').rules.some((x) => x.rule.includes('简短')));

// persona_store
const pa = new PersonaStore(dir);
const pu = pa.update('u2', ['爱用旺柴表情', '爱用旺财表情', '爱用旺柴表情'], '调侃风');
ok('persona 特征去重', pu.traits === 2);
ok('persona 风格', pa.get('u2')?.style === '调侃风');

// profile_store
const ps = new ProfileStore(dir);
ok('profile update 去重', ps.update('u3', ['称呼=鲸鱼爷', '称呼=鲸鱼爷']).total === 1);
ok('profile 合并', ps.update('u3', ['身份=群友']).total === 2);
ok('profile hint 非空', ps.hint('u3').includes('鲸鱼爷'));
ok('profile replace 纠错', ps.replace('u3', ['称呼=鲸鱼']).total === 1 && ps.get('u3')[0] === '称呼=鲸鱼');

// 统一落盘(模拟生产 2s 防抖 + stop flush)
facts.flush(); kb.flush(); rf.flush(); pa.flush(); ps.flush();

// ---- 跨 scope 检索(recallAll / hybridSearchAll) ----
const fa = new FactStore(dir + '/a');
fa.add('main', ['用户讨厌被叫胖', '用户爱喝奶茶']);
fa.add('group:123', ['昨天那家奶茶店真不错', '小明是学生']);
ok('recallAll 跨域命中奶茶', fa.recallAll('奶茶', 5).some((f) => f.text.includes('奶茶')));
ok('recallAll 跨域命中学生', fa.recallAll('学生', 5).some((f) => f.text.includes('学生')));
const vs = new VectorStore(dir + '/v');
vs.add('main', '用户讨厌被叫胖', null, 500);
vs.add('group:123', '昨天那家奶茶店真不错', null, 500);
ok('hybridSearchAll 跨域命中奶茶(BM25)', vs.hybridSearchAll('奶茶店', null, 5).some((h) => h.text.includes('奶茶')));
ok('hybridSearchAll 跨域命中胖(BM25)', vs.hybridSearchAll('被叫胖', null, 5).some((h) => h.text.includes('胖')));

// ---- 自动捕获(world 无关:只认 origin=external 的入站用户消息) ----
const capDir = mkdtempSync(join(tmpdir(), 'mem-cap-'));
const capFacts = new FactStore(capDir);
const capVecs = new VectorStore(capDir);
const events: EventEnvelope[] = [
  { origin: 'external', source: 'qq', senderKey: 'group:123', text: '【QQ群 测试群 12:00】小明：昨天那家奶茶店真不错', meta: { role: 'user' } } as EventEnvelope,
  { origin: 'internal', source: 'memory', text: '记忆快照: 话题=...' } as EventEnvelope, // 记忆自推,应跳过
  { origin: 'external', source: 'qq', senderKey: 'group:123', text: '【QQ群 测试群 12:01】肥鱼娘：认同', meta: { role: 'assistant', self: true } } as EventEnvelope, // bot 自言,应跳过
  { origin: 'external', source: 'other-world', senderKey: 'priv:999', text: '我也很喜欢这家店', meta: { role: 'user' } } as EventEnvelope, // 非 QQ world 也抓,验证无关性
  { origin: 'external', source: 'qq', senderKey: 'group:123', text: '好', meta: { role: 'user' } } as EventEnvelope, // 纯短消息(<minLength),应跳过
];
const w: any = new MemoryWorld({ dataDir: capDir, cfg: { ...MEMORY_DEFAULTS, autoCapture: true, embeddingProvider: 'off', captureMinLength: 2 } } as any);
w.facts = capFacts; w.vectors = capVecs; w.embedder = { embed: async () => null };
w.lastCursor = 0;
w.host = { isPaused: () => false, store: { latestCursor: () => 100, range: () => events } };
const captured = await w.captureIncoming();
ok('捕获只抓外部入站用户消息(跳过 internal/bot/短消息)=2条', captured === 2);
ok('捕获按 scope 落库(群)', capFacts.count('group:123') === 1);
ok('捕获 QQ 前缀已清理', capFacts.get('group:123')[0].text === '小明：昨天那家奶茶店真不错');
ok('捕获非 QQ world 也生效(验证无关性)', capFacts.count('priv:999') === 1);
ok('recallAll 能搜到自动捕获的对话', capFacts.recallAll('奶茶店', 5).some((f) => f.text.includes('奶茶店')));
capFacts.flush(); capVecs.flush();
rmSync(capDir, { recursive: true, force: true });

// 落盘 + JSON 合法性
for (const f of ['fact-store.json', 'knowledge-base.json', 'reflection-data.json', 'persona-data.json', 'user-profiles.json']) {
  const p = join(dir, f);
  let valid = false;
  try { JSON.parse(readFileSync(p, 'utf8')); valid = existsSync(p); } catch { valid = false; }
  ok('落盘+JSON合法 ' + f, valid);
}

rmSync(dir, { recursive: true, force: true });
console.log(`\n结果: ${pass} 通过 / ${fail} 失败`);
process.exit(fail ? 1 : 0);
