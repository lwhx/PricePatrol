export const exportFields = [
  ['shopName', '店铺'], ['productId', '商品 ID'], ['title', '商品标题'], ['sourceUrl', '商品链接'],
  ['skuId', 'SKU ID'], ['specs', '完整规格'], ['seatSpec', '座位规格'], ['color', '颜色'],
  ['backendPrice', '后台标价'], ['before', '优惠前价'], ['after', '优惠后价'], ['discount', '实际折扣'],
  ['saving', '优惠金额'], ['priceDifference', '优惠前与后台差额'], ['updatedAt', '采集时间'], ['status', '状态'],
  ['error', '失败原因'], ['tags', '标签'], ['note', '备注'],
] as const;
export const defaultFields = ['shopName', 'productId', 'title', 'skuId', 'specs', 'backendPrice', 'before', 'after', 'discount'];
export function orderedFields(value: string[]) {
  return [...new Set(value)].filter(key => exportFields.some(([field]) => field === key));
}
export function moveField(fields: string[], from: number, to: number) {
  if (from < 0 || to < 0 || from >= fields.length || to >= fields.length) return [...fields];
  const result = [...fields]; const [field] = result.splice(from, 1); result.splice(to, 0, field!); return result;
}
