(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.TmallSkuBatchPlatform = factory();
})(typeof globalThis === 'object' ? globalThis : this, function () {
  'use strict';
  const platforms = Object.freeze({
    tmall:Object.freeze({id:'tmall',api:'mtop.tmall.sell.pc.manage.async',route:'/tmall/manager/table.htm',detailHost:'detail.tmall.com',label:'天猫'}),
    taobao:Object.freeze({id:'taobao',api:'mtop.taobao.sell.pc.manage.async',route:'/taobao/manager/table.htm',detailHost:'item.taobao.com',label:'淘宝'})
  });
  const byId = id => typeof id === 'string' && Object.hasOwn(platforms,id) ? platforms[id] : null;
  const byApi = api => Object.values(platforms).find(platform => platform.api === api) || null;
  function endpoint(value) {
    try {
      if (typeof value !== 'string' || value.length > 1024*1024) return null;
      const url = new URL(value,'https://qn.taobao.com');
      if (!/^https?:$/.test(url.protocol) || !/(^|\.)(?:tmall|taobao)\.com$/i.test(url.hostname)) return null;
      const match = /^\/h5\/([^/]+)\/1\.0\/?$/.exec(url.pathname);
      return match ? byApi(match[1]) : null;
    } catch (_) { return null; }
  }
  function detail(value) {
    try {
      const url = new URL(value,'https://qn.taobao.com');
      if (!/^https?:$/.test(url.protocol) || url.pathname !== '/item.htm' || !/^\d{6,20}$/.test(url.searchParams.get('id') || '')) return null;
      return Object.values(platforms).find(platform => platform.detailHost === url.hostname) || null;
    } catch (_) { return null; }
  }
  // Keep only public platform evidence, never resource URLs or their credentials.
  function inspect(pageWindow) {
    const domIds = new Set(), resourceCounts = {tmall:0,taobao:0};
    try {
      const links = pageWindow?.document?.querySelectorAll('tr.next-table-row a.title-link[href], tr.sku-group-header-row[data-item-id] a[href]') || [];
      for (const link of links) { const platform = detail(link.getAttribute('href')); if (platform) domIds.add(platform.id); }
    } catch (_) {}
    try {
      for (const resource of pageWindow?.performance?.getEntriesByType('resource') || []) {
        const platform = endpoint(resource.name); if (platform) resourceCounts[platform.id]++;
      }
    } catch (_) {}
    const ids = new Set([...domIds,...Object.keys(resourceCounts).filter(id => resourceCounts[id]>0)]);
    return {domIds:[...domIds].sort(),resourceCounts,platform:ids.size === 1 ? byId([...ids][0]) : null};
  }
  const detect = pageWindow => inspect(pageWindow).platform;
  function productUrl(platformOrId, productId) {
    const platform = byId(typeof platformOrId === 'string' ? platformOrId : platformOrId?.id);
    if (!platform || !['string','number'].includes(typeof productId) || (typeof productId === 'number' && !Number.isSafeInteger(productId))
      || !/^\d{6,20}$/.test(String(productId))) throw new TypeError('未知平台或无效商品 ID');
    return `https://${platform.detailHost}/item.htm?id=${productId}`;
  }
  return Object.freeze({byApi,byId,detect,productUrl,endpoint,inspect});
});
