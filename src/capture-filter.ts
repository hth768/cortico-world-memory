import type { EventEnvelope } from 'cortico/core/types.ts';

/**
 * 自动捕获时判断事件是否为「真人入站消息」。
 * world 无关:只认 origin='external' + 非 bot 自言。
 *
 * 关键修正(0.2.5 之前的事实库污染根因):
 * 宿主推送的「外部事件」里混着非真人消息(桌宠自言 / 工具回执 / 系统互动模板 / 交接笔记),
 * 它们的 origin 也是 external(确属外部产生),但凭据(senderKey / meta.kind / source / type)能区分——
 * 旧实现只看了 origin/role/self,三个信号在桌面端事件上恰好都缺失,于是把 64% 的非用户消息也当成了「入站」。
 * 这里用 senderKey / meta.kind / source / type 一并排除。
 */
export function isInboundUser(e: EventEnvelope): boolean {
  if (e.origin !== 'external') return false; // 排除 internal 回灌 / 记忆自身推送
  const role = (e.meta?.role as string) ?? '';
  if (role === 'assistant' || role === 'bot' || e.meta?.self === true) return false; // 排除 bot 自己
  // 排除宿主推送的「非真人入站」外部事件。
  if (/\.self$/.test(e.senderKey ?? '')) return false;            // 桌宠自言 + 工具回执(desktop-pet.self)
  const kind = (e.meta?.kind as string) ?? '';
  if (kind === 'activity' || kind === 'delivered') return false;  // 做了:end_turn / 送达了 #9915
  if (e.source === 'desktop-pet' && e.type === 'desktop-pet.touch') return false; // 互动回执模板(摸头/拖动…)
  if (e.type === 'persona' || e.senderKey === 'persona') return false;            // 交接笔记(宿主生成的长文)
  return true;
}
