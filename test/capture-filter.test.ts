// 验证 isInboundUser 的「真人入站」判定(0.2.5 修复事实库被非用户消息污染)。
import { isInboundUser } from '../src/capture-filter.ts';

let pass = 0;
let fail = 0;
function ok(name: string, cond: boolean) {
  if (cond) { pass++; console.log(`  ok  - ${name}`); }
  else { fail++; console.log(`  FAIL- ${name}`); }
}

// 1. 真人入站(应捕获)
ok('桌面端用户输入 desktop-pet.chat', isInboundUser({ origin: 'external', source: 'desktop-pet', type: 'desktop-pet.chat', senderKey: 'desktop-pet.chat', meta: {} }) === true);
ok('QQ 私聊/群聊 origin=external', isInboundUser({ origin: 'external', source: 'qqbot', senderKey: 'qq:123456789', meta: {} }) === true);
ok('其它世界外部消息', isInboundUser({ origin: 'external', source: 'wechat', senderKey: 'wx:abc', meta: {} }) === true);

// 2. 非真人(应排除)
ok('internal 回灌', isInboundUser({ origin: 'internal', source: 'desktop-pet', type: 'desktop-pet.self' }) === false);
ok('assistant 角色', isInboundUser({ origin: 'external', meta: { role: 'assistant' } }) === false);
ok('bot self 标记', isInboundUser({ origin: 'external', meta: { self: true } }) === false);
// 桌宠自言 / 工具回执: senderKey=.self 一律排除(覆盖了反馈示例里 64% 的污染来源)
ok('桌宠自言(含 she 真实发言 say)', isInboundUser({ origin: 'external', source: 'desktop-pet', type: 'desktop-pet.self', senderKey: 'desktop-pet.self', meta: { kind: 'say' } }) === false);
ok('工具回执 activity', isInboundUser({ origin: 'external', source: 'desktop-pet', type: 'desktop-pet.self', senderKey: 'desktop-pet.self', meta: { kind: 'activity' } }) === false);
ok('送达回执 delivered', isInboundUser({ origin: 'external', source: 'qqbot', senderKey: 'qq:123', meta: { kind: 'delivered' } }) === false);
// 系统互动模板(摸头/拖动…): origin 也是 external,但 type=desktop-pet.touch
ok('系统互动模板 touch', isInboundUser({ origin: 'external', source: 'desktop-pet', type: 'desktop-pet.touch' }) === false);
// 交接笔记: 宿主生成长文
ok('交接笔记 persona', isInboundUser({ origin: 'external', type: 'persona', senderKey: 'persona' }) === false);

console.log(`\n通过 ${pass} / 失败 ${fail}`);
if (fail > 0) process.exit(1);
