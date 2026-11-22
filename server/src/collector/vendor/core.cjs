(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.TmallSkuBatchCore = factory();
})(typeof globalThis === 'object' ? globalThis : this, function () {
  'use strict';
  const text = v => String(v == null ? '' : v).trim();
  const validId = v => /^\d{6,20}$/.test(text(v));
  function productsFromRecords(records, selectedOnly = false) {
    const found = new Map();
    for (const row of records) {
      try {
        const url = new URL(row.url);
        const id = url.searchParams.get('id');
        if (!['detail.tmall.com', 'item.taobao.com'].includes(url.hostname)
            || url.pathname !== '/item.htm' || !validId(id)) continue;
        const prior = found.get(id);
        found.set(id, {id, title: text(row.title) || prior?.title || '',
          url: `${url.origin}/item.htm?id=${id}`, selected: !!row.selected || !!prior?.selected});
      } catch (_) { /* unrelated link */ }
    }
    return [...found.values()].filter(p => !selectedOnly || p.selected);
  }
  function jsonObjectAt(source, start) {
    let depth = 0, quoted = false, escape = false;
    for (let i = start; i < source.length; i++) {
      const c = source[i];
      if (quoted) {
        if (escape) escape = false;
        else if (c === '\\') escape = true;
        else if (c === '"') quoted = false;
      } else if (c === '"') quoted = true;
      else if (c === '{') depth++;
      else if (c === '}' && --depth === 0) return JSON.parse(source.slice(start, i + 1));
    }
    throw Error('商品JSON不完整');
  }
  function parseHtml(html, expectedId) {
    if (typeof html !== 'string' || html.length > 20e6) throw Error('商品页面格式或大小异常');
    const scripts = html.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script\s*>/gi);
    for (const match of scripts) {
      const source = match[1];
      if (!source.includes('__ICE_APP_CONTEXT__')) continue;
      const anchors = [...source.matchAll(/(?:var\s+b\s*=\s*|(?:window\.)?__ICE_APP_CONTEXT__\s*=\s*)(\{)/g)];
      for (const anchor of anchors) {
        let data;
        try { data = jsonObjectAt(source, anchor.index + anchor[0].length - 1); } catch (_) { continue; }
        const res = data?.loaderData?.home?.data?.res || data?.appData?.data?.res;
        if (res?.skuCore && res?.item) {
          if (text(res.item.itemId) !== text(expectedId)) throw Error('返回商品ID不一致');
          return res;
        }
      }
    }
    throw Error('未取得商品SKU数据；请在详情页确认登录或完成验证后重试');
  }
  function priceValue(value) {
    if (!value || typeof value !== 'object' || value.hiddenPrice === true || value.hiddenPrice === 'true') return '';
    if (/起|范围|区间|[至~～]/.test(text(value.priceDesc))) return '';
    const raw = text(value.priceText).replace(/[￥¥,\s]/g, '');
    if (raw && !/^\d+(?:\.\d{1,2})?$/.test(raw)) return '';
    const cents = text(value.priceMoney);
    if (cents && /^\d+$/.test(cents) && Number.isSafeInteger(Number(cents))) {
      const amount = Number(cents) / 100;
      if (raw && Math.abs(Number(raw) - amount) > 0.005) return '';
      return amount.toFixed(2);
    }
    return raw ? Number(raw).toFixed(2) : '';
  }
  function rowsFromRes(res, expectedId, fetchedAt = new Date().toISOString(), sourceUrl = `https://detail.tmall.com/item.htm?id=${expectedId}`) {
    if (!validId(expectedId) || text(res?.item?.itemId) !== text(expectedId)) throw Error('返回商品ID不一致');
    const source=productsFromRecords([{url:sourceUrl}])[0];
    if(!source || source.id!==text(expectedId))throw Error('详情来源与商品ID不一致');
    const info = res?.skuCore?.sku2info;
    if (!info || typeof info !== 'object') throw Error('缺少SKU价格数据');
    const priceVO = res?.componentsVO?.priceVO;
    const promotionLabel = value => /优惠|原价|划线|到手|券后|活动|促销|定金|尾款/.test(text(value?.priceTitle));
    const hasPromotion = !!priceVO?.extraPrice || promotionLabel(priceVO?.price)
      || Object.values(info).some(s => s?.subPrice != null || promotionLabel(s?.price));
    const props = res?.skuBase?.props || [];
    const dict = new Map();
    for (const p of props) {
      for (const v of p.values || []) dict.set(`${p.pid}:${v.vid}`, [text(p.name), text(v.name)]);
    }
    const skus = Array.isArray(res?.skuBase?.skus) ? res.skuBase.skus : [];
    const order = [], ids = new Map();
    for (const sku of skus) {
      const id = text(sku.skuId);
      if (!validId(id)) throw Error('SKU ID格式异常');
      const path = text(sku.propPath);
      if (ids.has(id) && ids.get(id) !== path) throw Error('SKU ID对应多个规格');
      if (!ids.has(id)) { ids.set(id, path); order.push({skuId:id, propPath:path}); }
    }
    for (const id of Object.keys(info)) {
      if (id !== '0' && !ids.has(id)) {
        if (!validId(id)) throw Error('SKU ID格式异常');
        order.push({skuId:id, propPath:''});
      }
    }
    if (!order.length && info['0'] && !props.length) order.push({skuId:'', propPath:''});
    if (!order.length) throw Error('商品没有可确认的独立SKU');
    return order.map(sku => {
      const values = {}, warnings = [], seenPids = new Set();
      for (const pair of sku.propPath.split(';').filter(Boolean)) {
        const pid = pair.split(':')[0];
        if (seenPids.has(pid)) warnings.push('规格维度重复');
        seenPids.add(pid);
        const entry = dict.get(pair);
        if (entry) values[entry[0]] = entry[1]; else warnings.push('规格映射缺失');
      }
      for (const prop of props) {
        if (!seenPids.has(text(prop.pid))) warnings.push(`规格维度缺失:${text(prop.name) || text(prop.pid)}`);
      }
      if (sku.skuId && !sku.propPath) warnings.push('规格映射缺失');
      const row = info[sku.skuId || '0'];
      let before = '', after = '', beforeLabel = '', afterLabel = '', priceType = '优惠信息待确认';
      if (!row) warnings.push('缺少SKU价格数据');
      else {
        const p = row.price, s = row.subPrice;
        if (p && /优惠前|原价|划线价/.test(text(p.priceTitle))) {
          before = priceValue(p); beforeLabel = text(p.priceTitle);
        } else if (p && /^(售价|价格|销售价|一口价)?$/.test(text(p.priceTitle))) {
          before = priceValue(p); beforeLabel = 'SKU标价';
        }
        if (s && /优惠后|到手|券后|活动价|促销价/.test(text(s.priceTitle))) {
          after = priceValue(s); afterLabel = text(s.priceTitle);
        } else if (p && /优惠后|到手|券后|活动价|促销价/.test(text(p.priceTitle))) {
          after = priceValue(p); afterLabel = text(p.priceTitle);
        }
        if (before && !after && s == null && !hasPromotion
            && /^(售价|价格|销售价|一口价)?$/.test(text(p?.priceTitle))) {
          after = before; beforeLabel = '单一售价'; afterLabel = '无优惠（单一售价）'; priceType = '无优惠';
        } else if (before && after) {
          priceType = Number(after) < Number(before) ? '有优惠'
            : Number(after) === Number(before) ? '前后同价' : '价格异常';
        }
        if (!before) warnings.push('未提供可确认的优惠前价');
        if (!after) warnings.push('未提供可确认的优惠后价');
        if (before && after && Number(after) > Number(before)) warnings.push('优惠后价格高于优惠前');
      }
      const q = row?.quantity;
      return { productId:text(expectedId), title:text(res.item.title), skuId:sku.skuId,
        seatSpec:values['几人坐'] || values['适用人数'] || '', color:values['颜色分类'] || '',
        specs:Object.entries(values).map(([k,v])=>`${k}:${v}`).join('；'), before, after,
        beforeLabel, afterLabel, priceType, quantity:q !== '' && q != null && Number.isFinite(Number(q)) ? Number(q) : '',
        status:[...new Set(warnings)].join('；') || '完整', fetchedAt,
        sourceUrl:source.url };
    });
  }
  async function runPool(items, worker, {concurrency = 5, shouldStop = () => false, onResult = () => {}} = {}) {
    const results = items.map(() => ({pending:true}));
    let cursor = 0;
    const count = Math.max(1, Math.min(5, Number.isFinite(Number(concurrency)) ? Math.floor(Number(concurrency)) : 5));
    async function run() {
      while (cursor < items.length && !shouldStop()) {
        const i = cursor++;
        try { results[i] = {ok:true, value:await worker(items[i], i)}; }
        catch (e) { results[i] = {ok:false, error:text(e.message) || '采集失败'}; }
        await onResult(results[i], items[i], i);
      }
    }
    await Promise.all(Array.from({length:Math.min(count,items.length)},run));
    return results;
  }
  const columns = [['productId','商品ID'],['title','商品标题'],['skuId','SKU ID'],
    ['seatSpec','几人坐/适用人数'],['color','颜色分类'],['specs','完整规格'],
    ['backendPrice','后台SKU标价'],['before','详情页优惠前价格'],['after','前台当前售价'],['discountFold','实际总折扣（折）'],['discountAmount','相对后台优惠金额'],
    ['priceComparisonText','标价对照'],['priceDifference','标价差额（详情优惠前−后台）'],
    ['thresholdFold','预警阈值（折）'],['discountCheck','折扣预警'],['priceType','优惠状态'],['beforeLabel','优惠前口径'],['afterLabel','优惠后口径'],
    ['quantity','详情页库存'],['status','详情采集状态'],['backendStatus','后台匹配状态'],['backendQuantity','后台库存'],
    ['fetchedAt','前台采集时间'],['backendFetchedAt','后台采集时间'],['backendSource','后台来源'],['sourceUrl','详情来源']];
  function csvCell(value) {
    let s = String(value == null ? '' : value);
    if (/^[\s]*[=+\-@]/.test(s)) s = "'" + s;
    return /[",\r\n]/.test(s) ? '"' + s.replace(/"/g,'""') + '"' : s;
  }
  function parseThreshold(input) {
    const raw = text(input).replace(/折$/, '').trim();
    const match = raw.match(/^(\d{1,2})(?:\.(\d{1,2}))?$/);
    if (!match) return null;
    const hundredths = Number(match[1]) * 100 + Number((match[2] || '').padEnd(2, '0'));
    if (hundredths <= 0 || hundredths > 1000) return null;
    return {text:String(hundredths / 100), hundredths};
  }
  function moneyCents(value) {
    if (!['string','number'].includes(typeof value)) return null;
    const match = text(value).match(/^(\d+)(?:\.(\d{1,2}))?$/);
    if (!match || match[1].length > 14) return null;
    const cents = BigInt(match[1]) * 100n + BigInt((match[2] || '').padEnd(2, '0'));
    return cents <= BigInt(Number.MAX_SAFE_INTEGER) ? cents : null;
  }
  function centsText(cents) {
    const sign = cents < 0n ? '-' : '', n = cents < 0n ? -cents : cents;
    return sign + String(n / 100n) + '.' + String(n % 100n).padStart(2,'0');
  }
  function discountReport(sourceRows, threshold = '8') {
    const limit = parseThreshold(threshold);
    if (!limit) throw Error('折扣阈值须大于0、不超过10，最多2位小数');
    const products = new Set(), skus = new Set(), mismatchProducts = new Set(), mismatchSkus = new Set();
    let unknownRows = 0, abnormalRows = 0, priceComparisonUnknownRows = 0;
    const rows = sourceRows.map(row => {
      const before = moneyCents(row.backendPrice), after = moneyCents(row.after);
      const backendValid = row.backendVerified === true && row.backendStatus === '已匹配';
      const stale = /重试失败|旧数据待刷新/.test(text(row.status));
      const known = !stale && backendValid && before !== null && before > 0n && after !== null;
      const out = {...row, thresholdFold:limit.text, discountKnown:known, discountBelow:false,discountBasis:'后台SKU标价',
        discountFold:'', discountText:'无法判断', discountAmount:'', discountCheck:'无法判断：价格缺失或无效'};
      const detailBefore = moneyCents(row.before);
      out.priceComparisonKnown = !stale && backendValid && before !== null && detailBefore !== null;
      out.priceMismatch = out.priceComparisonKnown && before !== detailBefore;
      out.priceDifference = out.priceComparisonKnown ? centsText(detailBefore - before) : '';
      out.priceComparisonText = out.priceComparisonKnown
        ? out.priceMismatch ? `标价不一致（详情优惠前−后台：${out.priceDifference}元）` : '一致'
        : stale ? '无法对照：旧数据待刷新' : !backendValid || before === null ? '无法对照：缺少有效后台标价' : '无法对照：缺少有效详情优惠前价';
      if (!out.priceComparisonKnown) priceComparisonUnknownRows++;
      if (out.priceMismatch) {mismatchProducts.add(text(row.productId));mismatchSkus.add(text(row.productId)+':'+text(row.skuId));}
      if (!known) {
        unknownRows++;
        out.priceType = backendValid ? '前台售价待确认' : '后台价格待确认';
        if (stale) out.discountCheck = '无法判断：旧数据待刷新';
        else if (!backendValid) out.discountCheck = '无法判断：' + (text(row.backendStatus) || '缺少后台SKU标价');
        else if (before === 0n) out.discountCheck = '无法判断：后台标价为0';
        return out;
      }
      out.priceType = after < before ? '有优惠' : after === before ? '无优惠' : '价格异常';
      if (/^无优惠/.test(text(row.afterLabel)) && after !== before) out.afterLabel = '前台单一售价';
      out.discountFold = Number(after * 10n) / Number(before);
      out.discountAmount = centsText(before - after);
      out.discountBelow = after * 1000n < before * BigInt(limit.hundredths);
      const rounded4 = (after * 200000n + before) / (before * 2n);
      const scaled = String(rounded4).padStart(5,'0');
      const fraction = scaled.slice(-4).replace(/0+$/, '');
      const display = scaled.slice(0,-4) + (fraction ? '.' + fraction : '');
      out.discountText = display + '折';
      if (out.discountBelow && rounded4 >= BigInt(limit.hundredths) * 100n) {
        out.discountText = `<${limit.text}折（接近${display}折）`;
      }
      if (after > before) {out.discountCheck = '当前售价高于后台价';abnormalRows++;}
      else out.discountCheck = out.discountBelow ? `低于${limit.text}折` : '正常';
      if (out.discountBelow) {products.add(text(row.productId));skus.add(text(row.productId) + ':' + text(row.skuId));}
      return out;
    });
    return {rows, threshold:limit.text, alertProducts:products.size, alertSkus:skus.size,
      alertProductIds:[...products], unknownRows, abnormalRows,
      priceMismatchProducts:mismatchProducts.size, priceMismatchSkus:mismatchSkus.size, priceComparisonUnknownRows};
  }
  function sortDiscountRows(rows) {
    return [...rows].sort((a,b) => {
      if (!a.discountKnown || !b.discountKnown) return Number(!!b.discountKnown) - Number(!!a.discountKnown);
      const left = moneyCents(a.after) * moneyCents(b.backendPrice), right = moneyCents(b.after) * moneyCents(a.backendPrice);
      return left < right ? -1 : left > right ? 1 : 0;
    });
  }
  function toCsv(rows, {threshold = '8', onlyAlerts = false} = {}) {
    const decorated = discountReport(rows, threshold).rows.filter(row => !onlyAlerts || row.discountBelow);
    return '\ufeff' + [columns.map(c=>csvCell(c[1])).join(','),
      ...decorated.map(row=>columns.map(c=>csvCell(row[c[0]])).join(','))].join('\r\n');
  }
  return {productsFromRecords, parseHtml, rowsFromRes, runPool, toCsv, columns,
    parseThreshold, discountReport, sortDiscountRows};
});
