export function money(value: string | null | undefined): string {
  if (value == null || value === '' || !/^-?\d+(?:\.\d+)?$/.test(value)) return '—';
  const [whole, decimal = ''] = value.split('.');
  return `¥${whole.replace(/\B(?=(\d{3})+(?!\d))/g, ',')}.${decimal.padEnd(2, '0').slice(0, 2)}`;
}
export function moneyDifference(previous: string | null, current: string | null): string | null {
  if (previous == null || current == null || !/^\d+(?:\.\d{1,2})?$/.test(previous) || !/^\d+(?:\.\d{1,2})?$/.test(current)) return null;
  const cents = (value: string) => { const [whole, decimal = ''] = value.split('.'); return BigInt(whole!) * 100n + BigInt(decimal.padEnd(2, '0')); };
  const delta = cents(current) - cents(previous), absolute = delta < 0n ? -delta : delta;
  return `${delta < 0n ? '-' : ''}${absolute / 100n}.${String(absolute % 100n).padStart(2, '0')}`;
}
export function discount(value: string | null | undefined): string {
  if (value == null || value === '' || !Number.isFinite(Number(value))) return '无法判断';
  return `${Number(value).toFixed(4).replace(/\.?0+$/, '')}折`;
}
export function dateTime(value: string | null | undefined) {
  if (!value) return '—';
  const date = new Date(value); return Number.isNaN(date.getTime()) ? value : date.toLocaleString('zh-CN', { hour12: false, timeZone: 'Asia/Shanghai' });
}
export const statusLabels: Record<string, string> = {
  queued: '排队中', running: '采集中', success: '已完成', partial: '部分完成', failed: '失败', stopped: '已停止',
  auth_required: '等待登录 / 验证', recoverable: '待恢复', ok: '正常', error: '采集失败', backend_only: '仅后台价', stale: '陈旧数据',
  pending: '待处理', confirmed: '已确认', resolved: '已处理', valid: '会话有效', active: '有效', verified: '核验通过', invalid: '会话失效', unknown: '未核验',
  sent: '已通知', sending: '投递中', not_configured: '未配置', accepted: '已受理', disabled: '未启用', skipped: '已跳过', none: '未发送',
};
export function parseIds(input: string) {
  const ids = new Set<string>(), invalid: string[] = [];
  for (const token of input.split(/[\s,，;；]+/).filter(Boolean)) {
    let id = token;
    if (/^https?:/i.test(token)) {
      try { const url = new URL(token); id = ['detail.tmall.com', 'item.taobao.com'].includes(url.hostname) ? url.searchParams.get('id') || '' : ''; }
      catch { id = ''; }
    }
    if (/^\d{6,20}$/.test(id)) ids.add(id); else invalid.push(token);
  }
  return { ids: [...ids], invalid };
}
export function lines(input: string) { return [...new Set(input.split(/[\n,，;；]+/).map(value => value.trim()).filter(Boolean))]; }
