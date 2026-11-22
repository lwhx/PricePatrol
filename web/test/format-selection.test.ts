import { describe, it, expect } from 'vitest';
import { money, moneyDifference, discount, parseIds } from '../src/lib/format';
import { moveField, orderedFields } from '../src/lib/exportFields';
import { updatePageSelection, groupSelectedProducts } from '../src/lib/selection';
describe('价格与身份显示', () => {
  it('直接格式化十进制字符串，保留长金额精度且不把缺价当零', () => {
    expect(money('12345678901234567890.10')).toBe('¥12,345,678,901,234,567,890.10');
    expect(money('0')).toBe('¥0.00'); expect(money(null)).toBe('—'); expect(money('NaN')).toBe('—');
    expect(money('-1.2')).toBe('¥-1.20');
  });
  it('历史差额使用整数分计算，缺值不参与比较', () => { expect(moneyDifference('0.10', '0.20')).toBe('0.10'); expect(moneyDifference('1.00', '0.95')).toBe('-0.05'); expect(moneyDifference(null, '1.00')).toBeNull(); expect(moneyDifference('12345678901234567890.00', '12345678901234567890.01')).toBe('0.01'); });
  it('折扣显示最多四位，同时明确未知值和倒挂', () => {
    expect(discount('8.5001')).toBe('8.5001折'); expect(discount('10.0000')).toBe('10折');
    expect(discount('11.25')).toBe('11.25折'); expect(discount(null)).toBe('无法判断');
  });
  it('提取平台链接、去重、保留长ID并报告无效项', () => {
    const value = parseIds('12345678901234567890, https://detail.tmall.com/item.htm?id=12345678901234567890 https://item.taobao.com/item.htm?id=654321 wrong https://evil.example/?id=123456');
    expect(value.ids).toEqual(['12345678901234567890', '654321']); expect(value.invalid).toHaveLength(2);
  });
});
describe('复制字段与跨页选择', () => {
  it('过滤无效字段、去重并保留用户顺序', () => { expect(orderedFields(['title', 'after', 'title', 'bad', 'productId'])).toEqual(['title', 'after', 'productId']); });
  it('拖动顺序不修改原数组，越界时保持原顺序', () => { const before = ['productId', 'title', 'after']; expect(moveField(before, 2, 0)).toEqual(['after', 'productId', 'title']); expect(before).toEqual(['productId', 'title', 'after']); expect(moveField(before, 0, -1)).toEqual(before); });
  it('翻页保持旧页选择，当前页取消勾选仅影响当前页', () => {
    const a = { id: 'shop-a:p1:s1', shopId: 'shop-a', productId: '100000' }, b = { id: 'shop-a:p1:s2', shopId: 'shop-a', productId: '100000' }, c = { id: 'shop-b:p1:s1', shopId: 'shop-b', productId: '100000' };
    let selected = updatePageSelection(new Map(), [a, b], [a, b]);
    selected = updatePageSelection(selected, [c], [c]); expect(selected.size).toBe(3);
    selected = updatePageSelection(selected, [a, b], [b]); expect([...selected.keys()]).toEqual([c.id, b.id]);
    expect(groupSelectedProducts([...selected.values()])).toEqual([{ shopId: 'shop-b', productIds: ['100000'] }, { shopId: 'shop-a', productIds: ['100000'] }]);
  });
});
