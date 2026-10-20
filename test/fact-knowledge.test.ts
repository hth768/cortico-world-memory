import { join } from 'node:path';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { FactStore, FACT_TEXT_MAX } from '../src/fact-store.ts';
import { KnowledgeStore } from '../src/knowledge-store.ts';

let pass = 0;
let fail = 0;
function ok(name: string, cond: boolean, extra = '') {
  if (cond) { pass++; console.log(`  ok  - ${name}`); }
  else { fail++; console.log(`  FAIL- ${name} ${extra}`); }
}

const dir = mkdtempSync(join(tmpdir(), 'world-mem-test-'));

try {
  // ── 回归 1：fact.add 不得因 FACT_TEXT_MAX 未定义抛 ReferenceError（0.2.3 线上崩溃）──
  let facts: FactStore | null = null;
  let addErr = '';
  let added = -1;
  try {
    facts = new FactStore(dir);
    added = facts.add('main', ['用户喜欢拿铁咖啡,早上必喝']);
  } catch (e: any) {
    addErr = String(e && e.message ? e.message : e);
  }
  ok('fact.add 不抛错', addErr === '', addErr);
  ok('fact.add 写入 1 条', added === 1, `added=${added}`);

  // 超长文本按 FACT_TEXT_MAX 截断（同一常量既用于截断也必须已定义）
  const long = 'X'.repeat(FACT_TEXT_MAX + 500);
  facts!.add('main', [long]);
  const stored = facts!.get('main').find((f) => f.text.startsWith('XXXX'));
  ok('超长事实截断到 FACT_TEXT_MAX', !!stored && stored.text.length === FACT_TEXT_MAX, `len=${stored?.text.length}`);
  ok('FACT_TEXT_MAX 为正数', FACT_TEXT_MAX > 0, String(FACT_TEXT_MAX));

  // 去重仍生效
  ok('重复事实不重复写入', facts!.add('main', ['用户喜欢拿铁咖啡,早上必喝']) === 0);
  facts!.flush();

  // ── 回归 2：中文 2 字关键词可召回（旧实现 k.length>=3 直接过滤）──
  const kb = new KnowledgeStore(dir);
  kb.addEntry('项目代号', ['凤凰计划是内部代号', '启动于 2026 年'], ['凤凰', '代号']);

  ok('中文 2 字关键词命中查询', kb.recall('凤凰计划').length === 1, String(kb.recall('凤凰计划').length));
  ok('主题词命中查询', kb.recall('代号是什么').length === 1, String(kb.recall('代号是什么').length));

  // 反向子串：查询比关键词短也要命中
  kb.addEntry('部署信息', ['部署在东京机房'], ['东京机房节点']);
  ok('反向子串（查询短于关键词）命中', kb.recall('东京').length >= 1, String(kb.recall('东京').length));

  // 无关查询不应命中
  ok('无关查询不误命中', kb.recall('完全无关的词汇组合').length === 0);
  kb.flush();

  console.log(`\n通过 ${pass} / 失败 ${fail}`);
  if (fail > 0) process.exit(1);
} finally {
  rmSync(dir, { recursive: true, force: true });
}
