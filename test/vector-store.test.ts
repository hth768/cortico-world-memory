// 验证 VectorStore 的去重(B1)与后台补索引原语(B2)。
import { join } from 'node:path';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { VectorStore } from '../src/vector-store.ts';

let pass = 0;
let fail = 0;
function ok(name: string, cond: boolean, extra = '') {
  if (cond) { pass++; console.log(`  ok  - ${name}`); }
  else { fail++; console.log(`  FAIL- ${name} ${extra}`); }
}

const dir = mkdtempSync(join(tmpdir(), 'vs-test-'));
try {
  const vs = new VectorStore(dir);
  const v = [0.1, 0.2, 0.3, 0.4, 0.5];

  // B1: 相同文本重复 add 只保留 1 条(与 FactStore 去重镜像)
  vs.add('main', '用户喜欢拿铁', v, 100);
  vs.add('main', '用户喜欢拿铁', v, 100); // 重复
  vs.add('main', '用户喜欢抹茶', v, 100);
  const items = (vs as any).data.vectors['main'];
  ok('重复文本只存 1 条', items.length === 2, `len=${items.length}`);

  // B1: 前 200 字相同视为重复
  const longA = 'A'.repeat(200) + '尾巴1';
  const longB = 'A'.repeat(200) + '尾巴2';
  vs.add('main', longA, v, 100);
  vs.add('main', longB, v, 100); // 前 200 字相同 → 去重
  ok('前 200 字相同去重', (vs as any).data.vectors['main'].length === 3, `len=${(vs as any).data.vectors['main'].length}`);

  // maxPerScope 超额仍截断最旧
  const vs2 = new VectorStore(join(tmpdir(), 'vs-test-2'));
  for (let i = 0; i < 5; i++) vs2.add('main', `条目${i}`, v, 3);
  ok('超出上限截掉最旧', (vs2 as any).data.vectors['main'].length === 3, `len=${(vs2 as any).data.vectors['main'].length}`);

  // B2: 历史 null 向量可被扫描并在原地补建
  const vs3 = new VectorStore(join(tmpdir(), 'vs-test-3'));
  vs3.add('main', '无向量条目1', null, 100);
  vs3.add('main', '无向量条目2', null, 100);
  vs3.add('main', '有向量条目', v, 100);
  const pending0 = vs3.pendingVectors(10);
  ok('pendingVectors 找出 2 条 null', pending0.length === 2, `n=${pending0.length}`);
  // 补建第一条
  vs3.setVector(pending0[0].scope, pending0[0].index, v);
  const pending1 = vs3.pendingVectors(10);
  ok('补建后 pending 减为 1', pending1.length === 1, `n=${pending1.length}`);
  // 再补建第二条
  vs3.setVector(pending1[0].scope, pending1[0].index, v);
  ok('全部补建后 pending 为 0', vs3.pendingVectors(10).length === 0);
  // 原地修改不应改变条目数量
  ok('setVector 不增删条目', (vs3 as any).data.vectors['main'].length === 3, `len=${(vs3 as any).data.vectors['main'].length}`);

  console.log(`\n通过 ${pass} / 失败 ${fail}`);
  if (fail > 0) process.exit(1);
} finally {
  rmSync(dir, { recursive: true, force: true });
}
