import { join } from 'node:path';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { FactStore } from '../src/fact-store.ts';

let pass = 0;
let fail = 0;
function ok(name: string, cond: boolean, extra = '') {
  if (cond) { pass++; console.log(`  ok  - ${name}`); }
  else { fail++; console.log(`  FAIL- ${name} ${extra}`); }
}

const dir = mkdtempSync(join(tmpdir(), 'fp-test-'));
try {
  const fs = new FactStore(dir);
  fs.add('desktop-pet.chat', ['用户说想喝咖啡']);
  fs.add('desktop-pet.self', ['她自言自语了一句']);
  fs.add('persona', ['交接笔记长文']);
  fs.add('qq:123', ['群友说晚安']);
  fs.flush();

  const scopes = fs.listScopes();
  ok('listScopes 含 4 个域', scopes.length === 4, `n=${scopes.length}`);
  ok('count 总量 4', fs.count() === 4, String(fs.count()));

  // 预览式:空数组不删
  ok('purge 空数组删 0', fs.purge([]) === 0);
  ok('空数组后数据仍在', fs.count() === 4);

  // 清理疑似非真人域
  const isSuspect = (s: string) => /\.self$/.test(s) || s === 'persona' || s.includes('.touch') || (s.startsWith('desktop-pet.') && !s.endsWith('.chat'));
  const bad = fs.listScopes().filter(isSuspect);
  ok('疑似域判定命中 2 个', bad.length === 2 && bad.includes('desktop-pet.self') && bad.includes('persona'), bad.join(','));

  const removed = fs.purge(bad);
  ok('purge 删除 2 条', removed === 2, `n=${removed}`);
  ok('剩余仅 2 个真人域', fs.count() === 2, String(fs.count()));
  ok('被删域不再存在', !fs.listScopes().includes('persona'));

  // 落盘后重建仍能读到剩余(持久化生效)
  fs.flush();
  const fs2 = new FactStore(dir);
  ok('重启后剩余 2 条', fs2.count() === 2, String(fs2.count()));
  ok('重启后 persona 已消失', !fs2.listScopes().includes('persona'));

  console.log(`\n通过 ${pass} / 失败 ${fail}`);
  if (fail > 0) process.exit(1);
} finally {
  rmSync(dir, { recursive: true, force: true });
}
