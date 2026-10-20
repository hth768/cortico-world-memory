// 回归测试:记忆快照不能在空闲期间重复堆积。
// 事故:每 30s 无条件推一份全文,空闲 02:32→03:09 积压几十份完全相同的快照,
// 下一次唤醒整批投递 → 单轮上下文被打爆。
// 运行:node test/snapshot.test.ts
import { SnapshotPusher } from '../src/snapshot.ts';
import { snapshotSignature } from '../src/observe.ts';

let fails = 0;
const ok = (cond: unknown, msg: string) => {
  if (!cond) { fails++; console.error('  FAIL:', msg); } else console.log('  ok  :', msg);
};

/** 模拟总线:queued 是"已入队未投递"的游标。 */
function makeSink() {
  let cursor = 0;
  const queued = new Set<number>();
  let pushCalls = 0;
  let failNext = false;
  return {
    queued,
    get pushCalls() { return pushCalls; },
    failNextPush() { failNext = true; },
    /** 模拟"整批投递":队列清空。 */
    deliver() { const n = queued.size; queued.clear(); return n; },
    sink: {
      async push(_text: string) {
        pushCalls++;
        if (failNext) { failNext = false; return null; }
        cursor++;
        queued.add(cursor);
        return cursor;
      },
      async withdraw(c: number) {
        if (!queued.has(c)) return false; // 已投递
        queued.delete(c);
        return true;
      },
    },
  };
}

const view: any = {
  topic: '日常',
  summary: '聊了天气',
  notes: [{ text: '主人喜欢安静', ts: 1 }],
  scopes: ['main'],
  vectorStats: { scopes: 1, total: 10, indexed: 10, model: 'm' },
  profileHint: '18 条档案……',
};
const sigOf = (v: any) => snapshotSignature(v);

// 1) 首次推送
{
  const s = makeSink();
  const p = new SnapshotPusher(s.sink);
  ok(await p.maybePush(sigOf(view), 'snapshot-1'), 'first snapshot pushed');
  ok(s.queued.size === 1, 'queue holds exactly 1 snapshot');
}

// 2) 空闲 37 分钟 ≈ 74 拍,内容没变 → 队列仍是 1
{
  const s = makeSink();
  const p = new SnapshotPusher(s.sink);
  await p.maybePush(sigOf(view), 'snapshot');
  for (let i = 0; i < 74; i++) await p.maybePush(sigOf(view), 'snapshot');
  ok(s.pushCalls === 1, `unchanged content pushed only once (actual ${s.pushCalls})`);
  ok(s.queued.size === 1, 'idle backlog stays at 1 (was dozens before fix)');
}

// 3) 统计数字变化(向量条数)→ 语义指纹不变 → 不重推
{
  const s = makeSink();
  const p = new SnapshotPusher(s.sink);
  await p.maybePush(sigOf(view), 'snapshot');
  const v2 = { ...view, vectorStats: { ...view.vectorStats, total: 11, indexed: 11 } };
  await p.maybePush(sigOf(v2), 'snapshot2');
  ok(s.pushCalls === 1, 'volatile stats do not retrigger push');
}

// 4) 真内容变化 → 撤回旧的未投递快照,队列仍为 1(原位替换)
{
  const s = makeSink();
  const p = new SnapshotPusher(s.sink);
  await p.maybePush(sigOf(view), 'snapshot-1');
  const v2 = { ...view, notes: [...view.notes, { text: '新增偏好', ts: 2 }] };
  await p.maybePush(sigOf(v2), 'snapshot-2');
  ok(s.queued.size === 1, 'changed content replaces pending snapshot (queue stays 1)');
  ok(s.pushCalls === 2, 'changed content does push a new snapshot');
}

// 5) 上一条已投递后再变化 → 正常推新的一条
{
  const s = makeSink();
  const p = new SnapshotPusher(s.sink);
  await p.maybePush(sigOf(view), 'snapshot-1');
  s.deliver();
  const v2 = { ...view, topic: '新话题' };
  await p.maybePush(sigOf(v2), 'snapshot-2');
  ok(s.queued.size === 1 && s.pushCalls === 2, 'after delivery, next change queues 1 new snapshot');
}

// 6) force:内容没变也推(启动首推)
{
  const s = makeSink();
  const p = new SnapshotPusher(s.sink);
  await p.maybePush(sigOf(view), 'snapshot');
  await p.maybePush(sigOf(view), 'snapshot', true);
  ok(s.pushCalls === 2 && s.queued.size === 1, 'force repushes but still keeps one pending');
}

// 7) invalidate(导入后)→ 同内容也重推
{
  const s = makeSink();
  const p = new SnapshotPusher(s.sink);
  await p.maybePush(sigOf(view), 'snapshot');
  p.invalidate();
  await p.maybePush(sigOf(view), 'snapshot');
  ok(s.pushCalls === 2, 'invalidate forces refresh after import');
}

// 8) 推送失败不写指纹 → 下一拍重试
{
  const s = makeSink();
  const p = new SnapshotPusher(s.sink);
  s.failNextPush();
  ok((await p.maybePush(sigOf(view), 'snapshot')) === false, 'failed push reports false');
  ok((await p.maybePush(sigOf(view), 'snapshot')) === true, 'failed push retried next tick');
  ok(s.queued.size === 1, 'retry leaves exactly one pending');
}

// 9) 并发拍:上一拍未落定时跳过,不推两条
{
  const s = makeSink();
  const p = new SnapshotPusher(s.sink);
  const a = p.maybePush(sigOf(view), 'a');
  const b = p.maybePush(sigOf(view), 'b', true);
  await Promise.all([a, b]);
  ok(s.pushCalls === 1 && s.queued.size === 1, 'concurrent ticks do not double push');
}

console.log(fails === 0 ? '\nALL PASS' : `\n${fails} FAILURE(S)`);
process.exit(fails === 0 ? 0 : 1);
