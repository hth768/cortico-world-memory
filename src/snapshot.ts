// 记忆快照推送去重策略(与框架解耦,便于单测)。
//
// 背景:记忆快照走 `origin:'internal'` + `trigger:'piggyback'`。框架对 piggyback 的语义是
// 「只入队,不唤醒回合、不启动批次计时器」,等下一次真正的唤醒整批投递。因此:
//   - 每 30s 无条件推一份全文 → 空闲/暂停期间队列里堆几十份一模一样的超长文本,
//     下次一有消息就整批灌进上下文(实测 02:32→03:09 积压几十份,单轮上下文被打爆);
//   - 框架不会帮我们合并这些重复项,去重必须由 World 自己负责。
//
// 这里给出两条保证:
//   1) 内容没变就不推(语义指纹去重);
//   2) 推新的之前把上一条「还没投递」的撤回 —— 等价于 qq_bot 的「原位替换」,
//      队列里任何时刻最多只有一条快照。

export interface SnapshotSink {
  /** 推一条快照,返回事件游标;失败返回 null。 */
  push(text: string): Promise<number | null>;
  /** 撤回一条尚未投递的事件;已投递或宿主不支持时返回 false。 */
  withdraw(cursor: number): Promise<boolean>;
}

export class SnapshotPusher {
  private lastSig: string | null = null;
  private pending: number | null = null;
  private inFlight = false; // 上一拍还没落定就跳过本拍,避免并发推出两条
  private readonly sink: SnapshotSink;

  // 显式赋值而非参数属性:便于用 `node xxx.ts`(type-stripping)直接跑单测。
  constructor(sink: SnapshotSink) {
    this.sink = sink;
  }

  /** 当前是否还有未投递的快照(观测/诊断用)。 */
  get hasPending(): boolean {
    return this.pending !== null;
  }

  /** 内容有变(或 force)时推送;返回是否真的推了。 */
  async maybePush(signature: string, text: string, force = false): Promise<boolean> {
    if (this.inFlight) return false;
    if (!force && signature === this.lastSig) return false;
    this.inFlight = true;
    try {
      if (this.pending !== null) {
        const cur = this.pending;
        this.pending = null;
        try {
          await this.sink.withdraw(cur);
        } catch {
          // 已投递 / 宿主不支持撤回:都无需处理,继续推新的即可
        }
      }
      const cursor = await this.sink.push(text);
      if (cursor === null) return false; // 推失败:不改指纹,下一拍重试
      this.lastSig = signature;
      this.pending = cursor;
      return true;
    } finally {
      this.inFlight = false;
    }
  }

  /** 数据被整体替换(导入/迁移)后调用,使下一拍必定重推。 */
  invalidate(): void {
    this.lastSig = null;
  }
}
