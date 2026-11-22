// ==UserScript==
// @name         淘宝/天猫 Cookie 导出（价格监控用）
// @namespace    local.tmall.cookie-export
// @version      1.2.1
// @description  读取当前浏览器淘宝/天猫全部 Cookie（含 HttpOnly）与千牛 appKey，一键复制为价格监控应用可直接导入的 JSON。只读，不修改任何 Cookie。
// @author       Hermes Agent
// @match        https://*.taobao.com/*
// @match        https://*.tmall.com/*
// @connect      taobao.com
// @connect      tmall.com
// @grant        GM_cookie
// @grant        GM_setClipboard
// @grant        GM_registerMenuCommand
// @grant        GM_getValue
// @grant        GM_setValue
// @grant        GM_addStyle
// @run-at       document-idle
// @noframes
// ==/UserScript==

(function () {
  'use strict';

  // ---------- 纯逻辑（可在 Node 中直接测试） ----------
  const QUERY_DOMAINS = Object.freeze([
    'taobao.com', 'tmall.com',
    'qn.taobao.com', 'h5api.m.taobao.com', 'login.taobao.com', 'myseller.taobao.com',
    'detail.tmall.com', 'sso.tmall.com',
  ]);
  const NAME_RE = /^[!#$%&'*+.^_`|~\w-]+$/;
  const BAD_VALUE_RE = /[\x00-\x20\x7f;]/;

  function isMarketDomain(domain) {
    return typeof domain === 'string' && /(^|\.)(?:taobao|tmall)\.com$/i.test(domain.replace(/^\./, ''));
  }

  function normalizeCookie(raw, now) {
    const at = typeof now === 'number' ? now : Date.now();
    if (!raw || typeof raw !== 'object') return null;
    const name = typeof raw.name === 'string' ? raw.name : '';
    const value = typeof raw.value === 'string' ? raw.value : '';
    if (!NAME_RE.test(name) || BAD_VALUE_RE.test(value)) return null;
    if (!isMarketDomain(raw.domain)) return null;
    const rawExpiry = Number.isFinite(raw.expirationDate) ? raw.expirationDate
      : Number.isFinite(raw.expires) ? raw.expires : undefined;
    const expires = rawExpiry === undefined ? undefined : Math.round(rawExpiry);
    if (expires !== undefined && expires > 0 && expires * 1000 <= at) return null; // 已过期
    const cookie = {
      name,
      value,
      domain: raw.domain,
      path: typeof raw.path === 'string' && raw.path.charAt(0) === '/' ? raw.path : '/',
      secure: !!raw.secure,
      httpOnly: !!raw.httpOnly,
    };
    if (expires !== undefined && expires > 0) cookie.expires = expires;
    else cookie.session = true;
    const sameSite = typeof raw.sameSite === 'string' ? raw.sameSite.toLowerCase() : '';
    if (sameSite === 'strict' || sameSite === 'lax' || sameSite === 'none') cookie.sameSite = sameSite;
    return cookie;
  }

  function dedupeCookies(list, now) {
    const seen = new Map();
    for (const raw of Array.isArray(list) ? list : []) {
      const cookie = normalizeCookie(raw, now);
      if (!cookie) continue;
      const key = cookie.domain + '\n' + cookie.path + '\n' + cookie.name;
      const prior = seen.get(key);
      if (!prior || (cookie.expires || 0) > (prior.expires || 0)) seen.set(key, cookie);
    }
    return [...seen.values()].sort((left, right) => {
      const domain = left.domain.localeCompare(right.domain);
      return domain !== 0 ? domain : left.name.localeCompare(right.name);
    });
  }

  function toHeaderString(cookies) {
    const seen = new Set();
    const parts = [];
    for (const cookie of Array.isArray(cookies) ? cookies : []) {
      if (!cookie || typeof cookie.name !== 'string' || seen.has(cookie.name)) continue;
      seen.add(cookie.name);
      parts.push(cookie.name + '=' + cookie.value);
    }
    return parts.join('; ');
  }

  function toImportPayload(input) {
    const source = input && typeof input === 'object' ? input : {};
    const cookies = dedupeCookies(source.cookies);
    const platform = source.platform === 'taobao' ? 'taobao' : 'tmall';
    const payload = { platform, cookies };
    const userAgent = typeof source.userAgent === 'string' ? source.userAgent.trim() : '';
    if (userAgent) payload.userAgent = userAgent;
    const appKey = String(source.appKey == null ? '' : source.appKey).trim();
    if (/^[A-Za-z0-9_-]{1,100}$/.test(appKey)) payload.appKey = appKey;
    return payload;
  }

  function extractAppKey(resources, platform) {
    const api = platform === 'taobao' ? 'mtop.taobao.sell.pc.manage.async' : 'mtop.tmall.sell.pc.manage.async';
    let found = '';
    for (const entry of Array.isArray(resources) ? resources : []) {
      const url = typeof entry === 'string' ? entry : entry && typeof entry === 'object' ? entry.name : '';
      if (typeof url !== 'string' || url.indexOf(api) === -1) continue;
      const match = /[?&]appKey=([A-Za-z0-9_-]{1,100})/.exec(url);
      if (match) found = match[1];
    }
    return found;
  }

  function platformForHost(host) {
    return typeof host === 'string' && /(^|\.)tmall\.com$/i.test(host) ? 'tmall' : 'taobao';
  }

  /**
   * 平台识别：绝不能按域名判断。千牛用 qn.taobao.com 同时承载淘宝与天猫店铺，
   * 按域名判会把天猫店判成淘宝。只认两个证据，且必须唯一：
   *   1) 商品列表里的详情链接域名（detail.tmall.com → 天猫 / item.taobao.com → 淘宝）
   *   2) performance 中已发生的管理 API（mtop.tmall.sell.pc.manage → 天猫 / mtop.taobao... → 淘宝）
   * 证据冲突或没有证据 → 返回 null，由界面要求用户手动选择，不猜。
   * appKey 另算：千牛后台各业务 API 共用同一个公开 appKey，不限于 sell.pc.manage.*，
   * 因此从任意 /h5/mtop.<平台>. 资源取都行；只采信与已确认平台同前缀的取值。
   */
  const DETAIL_HOSTS = Object.freeze({ 'detail.tmall.com': 'tmall', 'item.taobao.com': 'taobao' });
  const PROTOCOL_RE = new RegExp('^https?:$');
  const ID_RE = new RegExp('^[0-9]{6,20}$');
  const MANAGE_API_RE = /\/h5\/(mtop\.(?:tmall|taobao)\.sell\.pc\.manage\.[^/]+)\/1\.0\/?/;
  const ANY_MTOP_RE = /\/h5\/(mtop\.(?:tmall|taobao)\.[^/]+)\/1\.0\/?/;
  function platformFromDetailUrl(value) {
    try {
      const url = new URL(value, 'https://qn.taobao.com');
      if (!PROTOCOL_RE.test(url.protocol) || url.pathname !== '/item.htm') return null;
      if (!ID_RE.test(url.searchParams.get('id') || '')) return null;
      return DETAIL_HOSTS[url.hostname] || null;
    } catch (_) { return null; }
  }
  function detectPlatform(resources, hrefs) {
    const ids = new Set();
    const appKeysByPlatform = { tmall: new Set(), taobao: new Set() };
    for (const href of Array.isArray(hrefs) ? hrefs : []) {
      const id = platformFromDetailUrl(href);
      if (id) ids.add(id);
    }
    for (const entry of Array.isArray(resources) ? resources : []) {
      const url = typeof entry === 'string' ? entry : entry && typeof entry === 'object' ? entry.name : '';
      if (typeof url !== 'string') continue;
      const key = /[?&]appKey=([A-Za-z0-9_-]{1,100})/.exec(url);
      const manage = MANAGE_API_RE.exec(url);
      if (manage) ids.add(manage[1].indexOf('mtop.tmall.') === 0 ? 'tmall' : 'taobao');
      const any = ANY_MTOP_RE.exec(url);
      if (any && key) appKeysByPlatform[any[1].indexOf('mtop.tmall.') === 0 ? 'tmall' : 'taobao'].add(key[1]);
    }
    const platform = ids.size === 1 ? [...ids][0] : null;
    // appKey 只取与已确认平台同前缀的；平台未定时不猜（两平台 appKey 可能不同）。
    const appKeys = platform ? [...appKeysByPlatform[platform]] : [];
    return { platform, conflicting: [...ids].sort(), appKeys };
  }

  function summarize(cookies) {
    const list = Array.isArray(cookies) ? cookies : [];
    const domains = {};
    let httpOnly = 0;
    let session = 0;
    for (const cookie of list) {
      if (!cookie) continue;
      const domain = cookie.domain.replace(/^\./, '');
      domains[domain] = (domains[domain] || 0) + 1;
      if (cookie.httpOnly) httpOnly += 1;
      if (cookie.session) session += 1;
    }
    return { total: list.length, httpOnly, session, domains };
  }

  const CORE = Object.freeze({
    QUERY_DOMAINS, isMarketDomain, normalizeCookie, dedupeCookies,
    toHeaderString, toImportPayload, extractAppKey, platformForHost, summarize,
    platformFromDetailUrl, detectPlatform,
  });

  if (typeof document === 'undefined' || typeof window === 'undefined') {
    if (typeof module === 'object' && module && module.exports) module.exports = CORE;
    return;
  }

  // ---------- 浏览器界面 ----------
  const POSITION_KEY = 'cookie-export.position';
  const PANEL_KEY = 'cookie-export.panel';
  const host = String(location.hostname || '');
  if (/^(?:login|passport)\./i.test(host)) return; // 不在登录/身份页打扰

  function gmValue(key, fallback) {
    try { return typeof GM_getValue === 'function' ? GM_getValue(key, fallback) : fallback; } catch (_) { return fallback; }
  }
  function gmStore(key, value) {
    try { if (typeof GM_setValue === 'function') GM_setValue(key, value); } catch (_) { /* 存不下就只在本次生效 */ }
  }

  let gmCookieBroken = false;
  const CALL_TIMEOUT_MS = 4000;
  function listCookies(details) {
    return new Promise((resolve, reject) => {
      let settled = false;
      const finish = (fn, value) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        fn(value);
      };
      // GM_cookie 在个别域上会静默不回调，必须自带超时，否则面板永远停在“正在读取…”。
      const timer = setTimeout(() => {
        finish(reject, new Error('GM_cookie 无响应（' + (details.domain || details.url) + '）'));
      }, CALL_TIMEOUT_MS);
      const ok = cookies => finish(resolve, Array.isArray(cookies) ? cookies : []);
      const bad = error => finish(reject, error instanceof Error ? error : new Error('GM_cookie 读取失败：' + String(error || '未知错误')));
      try {
        const scoped = typeof GM !== 'undefined' && GM && GM.cookie;
        if (scoped && typeof scoped.list === 'function') {
          Promise.resolve(scoped.list(details)).then(ok, bad);
          return;
        }
        if (typeof GM_cookie === 'function') {
          GM_cookie('list', details, (cookies, error) => { if (error) bad(error); else ok(cookies); });
          return;
        }
        if (typeof GM_cookie !== 'undefined' && GM_cookie && typeof GM_cookie.list === 'function') {
          GM_cookie.list(details, (cookies, error) => { if (error) bad(error); else ok(cookies); });
          return;
        }
        finish(reject, new Error('GM_cookie 不可用（脚本授权里缺少 GM_cookie）'));
      } catch (error) {
        bad(error);
      }
    });
  }

  async function collectAll(platform) {
    const collected = [];
    const failures = [];
    let httpOnlyCapable = false;
    for (const domain of QUERY_DOMAINS) {
      try {
        const list = await listCookies({ domain });
        for (const cookie of list) {
          collected.push(cookie);
          if (cookie && cookie.httpOnly) httpOnlyCapable = true;
        }
      } catch (error) {
        gmCookieBroken = true;
        const text = error && error.message ? error.message : String(error);
        if (failures.indexOf(text) === -1) failures.push(text);
      }
    }
    if (!collected.length) {
      // 兜底：document.cookie 只能读到当前 host 的非 HttpOnly 项，缺 httpOnly 会导致采集签名失败。
      for (const part of String(document.cookie || '').split(';')) {
        const at = part.indexOf('=');
        if (at <= 0) continue;
        collected.push({ name: part.slice(0, at).trim(), value: part.slice(at + 1).trim(), domain: host, path: '/', secure: location.protocol === 'https:', httpOnly: false });
      }
    }
    return {
      cookies: dedupeCookies(collected),
      httpOnlyCapable,
      failures,
      resources: typeof performance !== 'undefined' && performance.getEntriesByType
        ? performance.getEntriesByType('resource').map(entry => entry.name)
        : [],
      hrefs: document.querySelectorAll('[href*="item.htm"]').length
        ? [...document.querySelectorAll('[href*="item.htm"]')].map(link => link.getAttribute('href')).filter(Boolean)
        : [],
    };
  }

  GM_addStyle([
    '#tce-launch{position:fixed;z-index:2147483600;right:24px;bottom:24px;padding:8px 12px;border-radius:18px;',
    'background:#0e918b;color:#fff;font:13px/1.4 "Microsoft YaHei",sans-serif;cursor:grab;user-select:none;',
    'box-shadow:0 6px 18px rgba(14,145,139,.32)}',
    '#tce-launch.dragging{cursor:grabbing}',
    '#tce-panel{position:fixed;z-index:2147483601;right:24px;bottom:74px;width:520px;max-width:calc(100vw - 32px);',
    'background:#fff;color:#233248;border:1px solid #dde5ed;border-radius:10px;box-shadow:0 16px 40px rgba(20,40,70,.18);',
    'font:13px/1.5 "Microsoft YaHei",sans-serif;padding:14px 16px 16px;display:none}',
    '#tce-panel.open{display:block}',
    '#tce-panel h3{margin:0 0 8px;font-size:14px;font-weight:600}',
    '#tce-panel .tce-row{display:flex;gap:8px;align-items:center;flex-wrap:wrap;margin:8px 0}',
    '#tce-panel button{border:1px solid #cfdae6;background:#f7f9fc;color:#233248;border-radius:7px;padding:6px 10px;cursor:pointer;font:12px/1.4 inherit}',
    '#tce-panel button.primary{background:#0e918b;border-color:#0e918b;color:#fff}',
    '#tce-panel button:disabled{opacity:.5;cursor:not-allowed}',
    '#tce-panel select{border:1px solid #cfdae6;border-radius:7px;padding:5px 8px;font:12px/1.4 inherit;background:#fff}',
    '#tce-panel textarea{width:100%;box-sizing:border-box;height:132px;border:1px solid #dde5ed;border-radius:7px;',
    'padding:8px;font:11px/1.5 Consolas,monospace;resize:vertical;background:#fbfdff;color:#34455c}',
    '#tce-panel .tce-meta{color:#6b7c91;font-size:12px}',
    '#tce-panel .tce-warn{color:#c2410c;font-size:12px;margin-top:6px}',
    '#tce-panel .tce-ok{color:#0e918b}',
  ].join(''));

  const launcher = document.createElement('div');
  launcher.id = 'tce-launch';
  launcher.textContent = 'Cookie 导出';
  launcher.title = '拖动可移动位置，点击打开面板';

  const panel = document.createElement('div');
  panel.id = 'tce-panel';
  panel.innerHTML = [
    '<h3>淘宝 / 天猫 Cookie 导出</h3>',
    '<div class="tce-row"><span class="tce-meta">平台</span>',
    '<select id="tce-platform"><option value="tmall">天猫</option><option value="taobao">淘宝</option></select>',
    '<button id="tce-read" class="primary">重新读取</button>',
    '<button id="tce-close">关闭</button></div>',
    '<div class="tce-row tce-meta" id="tce-stat">尚未读取</div>',
    '<textarea id="tce-preview" readonly spellcheck="false"></textarea>',
    '<div class="tce-row"><button id="tce-copy-payload" class="primary">复制完整导入包</button>',
    '<button id="tce-copy-cookies">只复制 Cookie 数组</button>',
    '<button id="tce-copy-header">复制 Cookie 头</button>',
    '<button id="tce-download">下载 JSON</button></div>',
    '<div class="tce-warn" id="tce-warn"></div>',
  ].join('');

  const $ = id => panel.querySelector(id);
  let lastPayload = null;
  let lastCookies = [];
  let lastHeader = '';
  let detectedPlatform = null;
  let autoDetected = false;

  function setWarning(text) { $('#tce-warn').textContent = text || ''; }

  function render(state) {
    const cookies = state.cookies;
    const summary = summarize(cookies);
    // 平台以页面证据为准：千牛同域承载两平台，不能按域名猜。
    const detection = detectPlatform(state.resources, state.hrefs);
    if (detection.platform) {
      detectedPlatform = detection.platform;
      $('#tce-platform').value = detection.platform;
      autoDetected = true;
    } else {
      autoDetected = false;
    }
    const chosenPlatform = detectedPlatform || $('#tce-platform').value;
    const appKey = detection.appKeys[0] || extractAppKey(state.resources, chosenPlatform);
    const payload = toImportPayload({
      cookies,
      platform: chosenPlatform,
      userAgent: navigator.userAgent,
      appKey,
    });
    lastPayload = payload;
    lastCookies = cookies;
    lastHeader = toHeaderString(cookies);
    const domainText = Object.keys(summary.domains).sort()
      .map(domain => domain + ':' + summary.domains[domain]).join('  ') || '无';
    $('#tce-stat').innerHTML = '';
    const strong = document.createElement('span');
    strong.className = cookies.length ? 'tce-ok' : '';
    strong.textContent = '共 ' + summary.total + ' 条，HttpOnly ' + summary.httpOnly + ' 条，会话 ' + summary.session + ' 条';
    const detail = document.createElement('span');
    const platformText = detection.platform
      ? '平台：' + (detection.platform === 'tmall' ? '天猫' : '淘宝') + '（页面证据已确认）'
      : '平台：需手动选择（页面暂无可判定证据）';
    detail.textContent = '｜' + platformText + '｜appKey: ' + (appKey || '未取到');
    $('#tce-stat').append(strong, document.createElement('br'), detail, document.createElement('br'), document.createTextNode('Cookie 域：' + domainText));
    $('#tce-preview').value = JSON.stringify(payload, null, 2);
    if (!cookies.length) setWarning('没有读到 Cookie。请确认已登录淘宝/天猫，且脚本猫已授予 GM_cookie 权限（首次使用会弹授权）。');
    else if (!state.httpOnlyCapable) setWarning('警告：没有读到任何 HttpOnly Cookie（cookie2、sgcookie 等通常为 HttpOnly）。这样导出的会话无法用于签名请求，请检查 GM_cookie 授权。');
    else if (detection.conflicting.length > 1) setWarning('页面同时出现淘宝和天猫证据（' + detection.conflicting.join('/') + '），已按当前选择输出。请确认店铺平台后再复制。');
    else if (state.failures.length) setWarning('部分域读取超时（' + state.failures.length + ' 个），Cookie 仍可用；若缺 cookie2 请重试。');
    else if (!appKey) setWarning('未取到 appKey：请等待千牛商品列表加载后重新读取。建议复制完整导入包；应用若无法自动补齐 appKey，会提示手动填写。');
    else setWarning('');
  }

  async function read() {
    const button = $('#tce-read');
    button.disabled = true;
    $('#tce-stat').textContent = '正在读取…';
    try {
      const state = await collectAll($('#tce-platform').value);
      render(state);
      if (state.failures.length && !gmCookieBroken) setWarning(state.failures.join('；'));
      if (gmCookieBroken && state.cookies.length) {
        setWarning('部分域读取失败，可能缺少 HttpOnly Cookie：' + state.failures.join('；'));
      }
    } catch (error) {
      $('#tce-stat').textContent = '读取失败';
      setWarning(error && error.message ? error.message : String(error));
    } finally {
      button.disabled = false;
    }
  }

  function copy(text, label) {
    if (!text) { setWarning('没有可复制的内容，请先读取'); return; }
    try {
      if (typeof GM_setClipboard === 'function') GM_setClipboard(text, 'text');
      else if (navigator.clipboard && navigator.clipboard.writeText) void navigator.clipboard.writeText(text);
      setWarning(label + '已复制（' + text.length + ' 字符）。');
    } catch (error) {
      setWarning('复制失败：' + (error && error.message ? error.message : String(error)));
    }
  }

  function download() {
    if (!lastPayload) { setWarning('没有可下载的内容，请先读取'); return; }
    const blob = new Blob([JSON.stringify(lastPayload, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = 'taobao-cookies-' + lastPayload.platform + '-' + Date.now() + '.json';
    anchor.click();
    setTimeout(() => URL.revokeObjectURL(url), 4000);
  }

  $('#tce-read').addEventListener('click', () => { void read(); });
  $('#tce-platform').addEventListener('change', () => {
    detectedPlatform = $('#tce-platform').value; // 用户手动选择优先，后续不再被自动覆盖
    autoDetected = false;
    if (lastPayload) render({ cookies: lastCookies, resources: [], hrefs: [], failures: [], httpOnlyCapable: true });
  });
  $('#tce-close').addEventListener('click', () => { panel.classList.remove('open'); gmStore(PANEL_KEY, false); });
  $('#tce-copy-payload').addEventListener('click', () => copy(lastPayload ? JSON.stringify(lastPayload) : '', '完整导入包'));
  $('#tce-copy-cookies').addEventListener('click', () => copy(lastCookies.length ? JSON.stringify(lastCookies) : '', 'Cookie 数组'));
  $('#tce-copy-header').addEventListener('click', () => copy(lastHeader, 'Cookie 头'));
  $('#tce-download').addEventListener('click', download);

  // 拖动位置持久化；拖动结束不打开面板（位移阈值判定）
  (function enableDrag() {
    const saved = gmValue(POSITION_KEY, null);
    if (saved && typeof saved.left === 'number' && typeof saved.top === 'number') {
      launcher.style.left = Math.max(0, Math.min(window.innerWidth - 90, saved.left)) + 'px';
      launcher.style.top = Math.max(0, Math.min(window.innerHeight - 44, saved.top)) + 'px';
      launcher.style.right = 'auto';
      launcher.style.bottom = 'auto';
    }
    let dragging = false;
    let moved = false;
    let originX = 0;
    let originY = 0;
    let startLeft = 0;
    let startTop = 0;
    launcher.addEventListener('mousedown', event => {
      dragging = true;
      moved = false;
      originX = event.clientX;
      originY = event.clientY;
      const rect = launcher.getBoundingClientRect();
      startLeft = rect.left;
      startTop = rect.top;
      launcher.classList.add('dragging');
      event.preventDefault();
    });
    window.addEventListener('mousemove', event => {
      if (!dragging) return;
      const dx = event.clientX - originX;
      const dy = event.clientY - originY;
      if (Math.abs(dx) > 3 || Math.abs(dy) > 3) moved = true;
      launcher.style.left = Math.max(0, Math.min(window.innerWidth - launcher.offsetWidth, startLeft + dx)) + 'px';
      launcher.style.top = Math.max(0, Math.min(window.innerHeight - launcher.offsetHeight, startTop + dy)) + 'px';
      launcher.style.right = 'auto';
      launcher.style.bottom = 'auto';
    });
    window.addEventListener('mouseup', () => {
      if (!dragging) return;
      dragging = false;
      launcher.classList.remove('dragging');
      if (!moved) {
        toggle();
        return;
      }
      const rect = launcher.getBoundingClientRect();
      gmStore(POSITION_KEY, { left: Math.round(rect.left), top: Math.round(rect.top) });
    });
  })();

  function toggle() {
    const open = !panel.classList.contains('open');
    panel.classList.toggle('open', open);
    gmStore(PANEL_KEY, open);
    if (open) scheduleAutoRead();
  }

  /** 页面自身的 SPA 需要时间发出管理 API 请求并渲染详情链接；首次自动读取过早会误判“无证据”。 */
  function scheduleAutoRead() {
    let tries = 0;
    let done = false;
    const run = () => {
      if (done) return;
      tries += 1;
      void read();
      if (tries >= 4) { done = true; return; }
      setTimeout(() => {
        if (done) return;
        // 已由页面证据确认平台且拿到 appKey 就不必再试
        const pn = $('#tce-stat').textContent || '';
        if (pn.indexOf('已确认') !== -1 && pn.indexOf('appKey: 未取到') === -1) { done = true; return; }
        run();
      }, 3500);
    };
    setTimeout(run, 1200);
  }

  function mount() {
    if (document.getElementById('tce-launch')) return;
    document.body.appendChild(launcher);
    document.body.appendChild(panel);
    // 不按域名预设平台：千牛同域承载两平台，必须等页面证据。
    if (gmValue(PANEL_KEY, false) === true) {
      panel.classList.add('open');
      scheduleAutoRead();
    }
  }

  if (typeof GM_registerMenuCommand === 'function') {
    GM_registerMenuCommand('打开 Cookie 导出面板', () => {
      mount();
      panel.classList.add('open');
      gmStore(PANEL_KEY, true);
      scheduleAutoRead();
    });
  }

  if (document.body) mount();
  else document.addEventListener('DOMContentLoaded', mount, { once: true });
})();
