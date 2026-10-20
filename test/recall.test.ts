// 回归测试:mem_recall 返回不得超长(用户反馈单条/总量远超 8000)。
// 运行:node test/recall.test.ts
import { formatRecallResults, RECALL_BUDGET, RECALL_ITEM_MAX, RECALL_MAX_ITEMS } from '../src/recall.ts';

let fails = 0;
const ok = (c: unknown, m: string) => { if (!c) { fails++; console.error('  FAIL:', m); } else console.log('  ok  :', m); };

// 1) 单条超长 → 截断到 ITEM_MAX
{
  const long = 'x'.repeat(9000);
  const r = formatRecallResults([long]);
  ok(r.shown === 1 && r.body.length <= RECALL_ITEM_MAX + 10, `single 9000-char item truncated to ~${RECALL_ITEM_MAX}`);
  ok(r.body.endsWith('…'), 'truncated item ends with …');
}

// 2) 多条【不同】长文本叠加 → 预算触发截断,总量受控
{
  const items = Array.from({ length: 50 }, (_, i) => `第${i}条:${'y'.repeat(800)}`);
  const r = formatRecallResults(items);
  ok(r.shown < items.length && r.shown > 1, `distinct long items capped by budget (shown ${r.shown} < 50)`);
  ok(r.body.length <= RECALL_BUDGET + 50, `total body within budget (~${RECALL_BUDGET}), got ${r.body.length}`);
}

// 3) 重复项去重(事实与向量命中同一条)
{
  const r = formatRecallResults(['重复文本', '重复文本', '另一个']);
  ok(r.shown === 2, 'duplicates collapsed');
  ok(r.total === 3, 'total reflects pre-dedup count');
}

// 4) 总量预算内不截断,且不超过 maxItems
{
  const items = Array.from({ length: 100 }, (_, i) => `短文本${i}`);
  const r = formatRecallResults(items, { maxItems: 5 });
  ok(r.shown === 5, `maxItems honored (shown ${r.shown})`);
}

// 5) 边界:单条巨长先被截断,仍可继续容纳其它条目,且总量始终在预算内
{
  const huge = 'z'.repeat(RECALL_BUDGET * 3);
  const r = formatRecallResults([huge, '短']);
  ok(r.shown >= 1 && r.shown <= RECALL_MAX_ITEMS, `huge first item does not break loop (shown ${r.shown})`);
  ok(r.body.length <= RECALL_BUDGET + 50, `body still within budget, got ${r.body.length}`);
  ok(r.body.startsWith('1. zzz'), 'huge item included (truncated to prefix)');
}

console.log(fails === 0 ? '\nALL PASS' : `\n${fails} FAILURE(S)`);
process.exit(fails === 0 ? 0 : 1);
