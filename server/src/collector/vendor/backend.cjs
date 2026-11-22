(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.TmallSkuBatchBackend = factory();
})(typeof globalThis === 'object' ? globalThis : this, function () {
  'use strict';
  const API = 'mtop.tmall.sell.pc.manage.async';
  const sourceApi = value => [API,'mtop.taobao.sell.pc.manage.async'].includes(value) ? value : null;
  const INITIAL_PAGE_SIZE = 100;
  const MAX_CONCURRENCY = 5;
  const MAX_CENTS = BigInt(Number.MAX_SAFE_INTEGER);
  const text = value => typeof value === 'string' ? value.trim() : '';
  const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);

  function controlled(message, code = 'BACKEND_INVALID_RESPONSE') {
    return Object.assign(new Error(message), {code});
  }
  function exactId(value) {
    if (typeof value === 'number' && !Number.isSafeInteger(value)) return '';
    if (typeof value !== 'number' && typeof value !== 'string') return '';
    const id = String(value).trim();
    return /^[1-9]\d{5,19}$/.test(id) ? id : '';
  }
  function positiveInteger(value) {
    if (!['string', 'number'].includes(typeof value) || !/^[1-9]\d*$/.test(String(value))) return null;
    const number = Number(value);
    return Number.isSafeInteger(number) && number > 0 ? number : null;
  }
  function money(value) {
    if (!['string', 'number'].includes(typeof value)) return null;
    const match = String(value).trim().match(/^(\d{1,14})(?:\.(\d{1,2}))?$/);
    if (!match) return null;
    const cents = BigInt(match[1]) * 100n + BigInt((match[2] || '').padEnd(2, '0'));
    if (cents > MAX_CENTS) return null;
    return {cents, text:String(cents / 100n) + '.' + String(cents % 100n).padStart(2, '0')};
  }
  function timestamp(value) {
    return typeof value === 'string' && /^\d{4}-\d{2}-\d{2}T/.test(value) && Number.isFinite(Date.parse(value));
  }
  function quantity(value) {
    if (!['number', 'string'].includes(typeof value) || String(value).trim() === '') return '';
    const number = Number(value);
    return Number.isSafeInteger(number) && number >= 0 ? number : '';
  }
  function authenticationFailure(value) {
    if (!object(value)) return false;
    const codes = [value.code, value.errorCode, value.subCode, value.status,
      ...(Array.isArray(value.ret) ? value.ret.map(code => typeof code === 'string' ? code.split('::')[0] : '') : [])];
    return codes.some(code => /TOKEN|SESSION_EXPIRED|ILLEGAL_ACCESS|NO_PERMISSION|PERMISSION_DENIED|AUTH|LOGIN|ACCESS_DENIED|INVALID_USER|USER_VALIDATE|SECURITY|RGV|FORBIDDEN|^401$|^403$/i.test(String(code ?? '')))
      || /登录|权限|认证/.test([value.message, value.msg, value.errorMsg].filter(part => typeof part === 'string').join(' '));
  }
  function authError() {
    return controlled('后台登录失效或无读取权限，请在千牛确认登录和权限后重新采集', 'BACKEND_AUTH_REQUIRED');
  }
  function readResult(response) {
    if (authenticationFailure(response)) throw authError();
    if (!Array.isArray(response?.ret) || !response.ret.length
        || !response.ret.every(ret => typeof ret === 'string' && /^SUCCESS(?:::.*)?$/.test(ret))) {
      throw controlled('后台接口未返回成功状态', 'BACKEND_REQUEST_FAILED');
    }
    let result = response.data?.result;
    if (typeof result === 'string') {
      try { result = JSON.parse(result); }
      catch (_) { throw controlled('后台业务数据格式异常'); }
    }
    if (authenticationFailure(result)) throw authError();
    if (!object(result)) throw controlled('后台业务数据格式异常');
    if (result.success !== true) throw controlled('后台业务返回失败', 'BACKEND_BUSINESS_FAILED');
    return result;
  }
  function normalizeSku(sku, productId, fetchedAt, api) {
    const skuId = exactId(sku?.skuId), price = money(sku?.price);
    if (!object(sku) || !skuId || !price || /起|范围|区间|[至~～]/.test(text(sku.priceDesc))) {
      throw controlled('后台SKU ID或精确金额校验失败');
    }
    return {productId, skuId, backendPrice:price.text, backendQuantity:quantity(sku.quantity),
      backendCategory:text(sku.skuQuality), backendSkuStatus:text(sku.status),
      backendFetchedAt:fetchedAt, backendSource:api};
  }
  function normalizeProduct(product, fetchedAt, api) {
    const productId = exactId(product?.itemId);
    if (!object(product) || !productId || !Array.isArray(product.skuList)) {
      throw controlled('后台商品ID或SKU列表校验失败');
    }
    const descriptions = product.itemDesc?.desc;
    const title = Array.isArray(descriptions) ? text(descriptions.find(item => item?.uiType === 'link')?.text) : '';
    return {productId, title, rows:product.skuList.map(sku => normalizeSku(sku, productId, fetchedAt, api))};
  }
  function parsePage(response, expectedCurrent, fetchedAt = new Date().toISOString()) {
    const result = readResult(response), pagination = result.data?.pagination;
    const api=sourceApi(response.sourceApi===undefined?API:response.sourceApi);
    if(!api)throw controlled('后台接口来源无法确认');
    const current = positiveInteger(pagination?.current), pageSize = positiveInteger(pagination?.pageSize);
    const total = positiveInteger(pagination?.total), expected = positiveInteger(expectedCurrent);
    if (!current || !pageSize || !total || !expected || current !== expected
        || current > Math.ceil(total / pageSize) || !timestamp(fetchedAt)) {
      throw controlled('后台分页或采集时间校验失败');
    }
    const source = result.data?.table?.dataSource;
    if (!Array.isArray(source) || source.length > pageSize) throw controlled('后台商品列表格式或页大小异常');
    const products = source.map(product => normalizeProduct(product, fetchedAt, api));
    return {current, pageSize, total, products, rows:products.flatMap(product => product.rows),
      emptyProductIds:[...new Set(products.filter(product => !product.rows.length).map(product => product.productId))]};
  }

  function pageError(error, current) {
    if (error?.code === 'BACKEND_PAGINATION_CHANGED') return '后台分页信息发生变化，请重新采集';
    if (error?.code === 'BACKEND_BUSINESS_FAILED') return `后台第${current}页业务返回失败`;
    if (error?.code === 'BACKEND_REQUEST_FAILED') return `后台第${current}页接口返回失败`;
    return `后台第${current}页数据格式、ID、金额或页码校验失败`;
  }
  function poolSize(value) {
    const size = Number(value);
    return Number.isFinite(size) ? Math.max(1, Math.min(MAX_CONCURRENCY, Math.floor(size))) : MAX_CONCURRENCY;
  }
  async function fetchForProducts({request, productIds, concurrency = 5, shouldStop = () => false,
    onProgress = () => {}, now = () => new Date().toISOString()}) {
    if (!Array.isArray(productIds) || productIds.some(id => !exactId(id))) {
      throw controlled('后台目标商品ID格式异常', 'BACKEND_CONFIGURATION');
    }
    if (![request, shouldStop, onProgress, now].every(callback => typeof callback === 'function')) {
      throw controlled('后台读取回调配置异常', 'BACKEND_CONFIGURATION');
    }
    const targets = [...new Set(productIds.map(exactId))], wanted = new Set(targets);
    const pages = new Map(), found = new Set(), failures = [];
    let baseline = null, pagesTotal = 0, nextPage = 2, stopped = false, halted = false, authenticationError = null;

    function snapshot() {
      const ordered = [...pages.values()].sort((a, b) => a.current - b.current);
      return {rows:ordered.flatMap(page => page.rows.filter(row => wanted.has(row.productId))).map(row => ({...row})),
        foundProductIds:targets.filter(id => found.has(id)), missingProductIds:targets.filter(id => !found.has(id)),
        pagesRead:pages.size, pagesTotal, stopped:stopped || halted,
        errors:[...failures].sort((a, b) => a.current - b.current).map(failure => failure.message)};
    }
    function stopRequested() {
      if (shouldStop()) stopped = true;
      return stopped;
    }
    async function progress() {
      try {
        await onProgress({pagesRead:pages.size, pagesTotal,
          foundProducts:found.size, missingProducts:targets.length - found.size});
      }
      catch (_) {
        if (!halted) failures.push({current:0, message:'后台读取进度回调失败，请重新采集'});
        halted = true;
      }
    }
    function recordFailure(error, current) {
      if (error?.code === 'BACKEND_AUTH_REQUIRED') authenticationError = authError();
      else {
        failures.push({current, message:pageError(error, current)});
        if (['BACKEND_INVALID_RESPONSE', 'BACKEND_PAGINATION_CHANGED'].includes(error?.code)) halted = true;
      }
    }
    function accept(page) {
      if (baseline && (page.pageSize !== baseline.pageSize || page.total !== baseline.total)) {
        throw controlled('后台分页信息发生变化', 'BACKEND_PAGINATION_CHANGED');
      }
      if (!baseline) { baseline = page; pagesTotal = Math.ceil(page.total / page.pageSize); }
      pages.set(page.current, page);
      for (const product of page.products) if (wanted.has(product.productId)) found.add(product.productId);
    }
    async function read(current, pageSize) {
      if (halted || authenticationError || stopRequested()) return;
      let response;
      try { response = await request({current, pageSize}); }
      catch (error) {
        if (authenticationFailure(error)) authenticationError = authError();
        else failures.push({current, message:`后台第${current}页请求失败，请稍后重新采集`});
        await progress();
        return;
      }
      try { accept(parsePage(response, current, now())); }
      catch (error) { recordFailure(error, current); }
      await progress();
    }
    async function worker() {
      while (nextPage <= pagesTotal && found.size < targets.length && !halted && !authenticationError) {
        if (stopRequested()) return;
        const current = nextPage++;
        await read(current, baseline.pageSize);
      }
    }

    if (!targets.length) return snapshot();
    await read(1, INITIAL_PAGE_SIZE);
    if (baseline && !halted && !authenticationError && !stopRequested() && found.size < targets.length) {
      await Promise.all(Array.from({length:Math.min(poolSize(concurrency), pagesTotal - 1)}, worker));
    }
    stopRequested();
    await progress();
    if (authenticationError) throw authenticationError;
    return snapshot();
  }

  function normalizedBackend(row, price) {
    if (!price || !sourceApi(row.backendSource) || !timestamp(row.backendFetchedAt)) return null;
    return {backendPrice:price.text, backendQuantity:quantity(row.backendQuantity),
      backendCategory:text(row.backendCategory), backendSkuStatus:text(row.backendSkuStatus),
      backendFetchedAt:row.backendFetchedAt, backendSource:row.backendSource};
  }
  function backendIndex(rows) {
    const index = new Map();
    for (const row of rows) {
      const productId = exactId(row?.productId), skuId = exactId(row?.skuId);
      if (!productId || !skuId) continue;
      const key = productId + ':' + skuId, price = money(row.backendPrice);
      const candidate = normalizedBackend(row, price), prior = index.get(key);
      if (!prior) index.set(key, {row:candidate, invalid:!candidate, conflict:false});
      else if (!candidate || !prior.row) prior.invalid = true;
      else if (prior.row.backendPrice !== candidate.backendPrice || prior.row.backendSource !== candidate.backendSource) prior.conflict = true;
      else if (Date.parse(candidate.backendFetchedAt) > Date.parse(prior.row.backendFetchedAt)) prior.row = candidate;
    }
    return index;
  }
  function priceType(afterValue, backendValue) {
    const after = money(afterValue), backend = money(backendValue);
    if (!after || !backend || backend.cents === 0n) return '待确认';
    return after.cents < backend.cents ? '有优惠' : after.cents === backend.cents ? '无优惠' : '价格异常';
  }
  function attach(frontRows, backendRows) {
    const index = backendIndex(backendRows);
    return frontRows.map(row => {
      const result = {...row, backendVerified:false, backendPrice:'', backendQuantity:'', backendCategory:'',
        backendSkuStatus:'', backendFetchedAt:'', backendSource:'', backendStatus:'未匹配后台SKU标价', priceType:'待确认'};
      if (result.afterLabel === '无优惠（单一售价）') result.afterLabel = '前台单一售价';
      const productId = exactId(row.productId), skuId = exactId(row.skuId);
      if (!productId || !skuId) { result.backendStatus = '缺少有效商品ID或SKU ID'; return result; }
      const match = index.get(productId + ':' + skuId);
      if (!match) return result;
      if (match.conflict) { result.backendStatus = '后台SKU标价冲突'; return result; }
      if (match.invalid) { result.backendStatus = '后台SKU数据无效'; return result; }
      let expected;
      try{
        if(typeof row.sourceUrl!=='string'||!row.sourceUrl)throw Error();
        const url=new URL(row.sourceUrl);
        if(url.protocol!=='https:'||url.username||url['pass'+'word']||url.pathname!=='/item.htm'
          ||url.searchParams.getAll('id').length!==1||url.searchParams.get('id')!==productId)throw Error();
        expected={'detail.tmall.com':API,'item.taobao.com':'mtop.taobao.sell.pc.manage.async'}[url.hostname];
      }catch(_){result.backendStatus='详情来源缺失或与商品不一致';return result;}
      if(!expected || expected!==match.row.backendSource){result.backendStatus='前后台商品平台不一致';return result;}
      return {...result, ...match.row, backendVerified:true, backendStatus:'已匹配',
        priceType:priceType(row.after, match.row.backendPrice)};
    });
  }
  return {parsePage, fetchForProducts, attach};
});
